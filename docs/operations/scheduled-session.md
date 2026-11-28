---
type: operations
status: active
reviewed: 2026-11-29
summary: The scheduled session: the deterministic caller, Schedules, the check before a pass and the notifier.
covers: [packages/app/src/items.ts, packages/app/src/schedule.ts]
---

# The scheduled session

Part of the [runbook](runbook.md).

## The deterministic caller

The scheduled session is `system items carry`, a deterministic caller with no model in the caller's role
([ADR-0020](../decisions/ADR-0020-the-scheduled-session-is-a-deterministic-caller.md) decisions 1 to 7). It talks only
to the caller socket (`$DSH_HOME/system/host.sock`), runs outside the bubblewrap layer, and never approves, denies,
retries a verify step, releases, or writes Items.

- `system items carry <id> --repo <path>` carries one Item and prints one JSON record on stdout (exits 0 only when the
  Item ended merged or held).
- `system items carry --repo <path>... [--max-parallel <n>]` or `system items carry --schedule <file>` runs one pass
  over the repositories in order.

A pass applies fixed rules:

1. Read `status` of each repository in the order given and take Ready Items in `STATUS.md` order.
2. Claim the Item, store the Task `Carry out Item <id> of STATUS.md: <line>`, and pick the Workflow (`develop.yaml`, or
   `<name>.yaml` when the line carries `(workflow: <name>)`; from `<repo>/workflows/` when present, else from the
   install's `workflows/`).
3. Submit and wait, running Works in parallel up to the free Accounts (`workers.list` `room`) and `maxParallel` when
   set. When a merged Item unblocks another Ready Item, the pass takes it too.
4. When a Work fails, submit one more Work with the failed Work's verdict Artifact in its context. An Item that already
   has two failed Works, is blocked, or has a running or held Work is skipped with the reason recorded.

Each pass is independent and re-enterable. A pass holds a per-repository lock under `$DSH_HOME/system` (released by the
kernel when the process exits), so an overlapping start is not a failure: it exits 0 at once and sends nothing to the
notifier. After a killed pass, the next pass reads the Claims and Works left in `status`, adopts any running Work, and
submits nothing twice.

## Schedules

A Schedule ([ADR-0020](../decisions/ADR-0020-the-scheduled-session-is-a-deterministic-caller.md) decision 6; GLOSSARY
Schedule) is a file `~/.system/schedules/<name>.yaml` (under `SYSTEM_INSTALL` when that is set):

| Key | Meaning |
| --- | --- |
| `kind` | `items`: carry the Ready Items of `repositories`. `kind: work` parses and is refused as not built yet. |
| `repositories` | Absolute paths (or `~/...`), in the order the pass reads them. |
| `at` | One or more systemd calendar expressions (a string or a list); each is checked with `systemd-analyze calendar` when that is on the `PATH`. |
| `maxParallel` | Optional: the most Works the pass runs at once. |
| `checkAt` | Optional: one calendar expression, the time of the check before a pass (below). |

Example `~/.system/schedules/daily.yaml` (System and DNA at 01:00, then hourly to 07:00):

```yaml
kind: items
repositories:
  - ~/workspaces/System
  - ~/workspaces/DNA
at:
  - "*-*-* 01:00"
  - "*-*-* 02..07:00"
```

`system init` (default home `~/.dsh` on Linux) writes, for each Schedule file, the user units
`system-schedule-<name>.service` (runs the install's `system items carry --schedule <file>`, with no `ExecStartPre` and
no start timeout; the command itself asks the Host for up to 5 minutes before giving up) and
`system-schedule-<name>.timer` (one `OnCalendar=` for each `at`, `Persistent=false`, so a start missed while the machine
was off is not run late) under `~/.config/systemd/user`. It enables none, rewrites a unit when its file or template
changed, and removes the units of a file that is gone. A file that does not parse is named on stderr, fails `init`, and
keeps its earlier units.

Enable a timer with `systemctl --user enable --now system-schedule-<name>.timer`, inspect it with
`systemctl --user list-timers 'system-schedule-*'` and `journalctl --user -u system-schedule-<name>`, and stop it with
`systemctl --user disable --now system-schedule-<name>.timer`.

## The check before a pass

`system items carry --schedule <file> --check` starts nothing. It asks `workers.list` once and reports any of:

- the Host does not answer;
- a repository's status cannot be read;
- Items are Ready and an Account is not available (for example signed out) or no Account is free (under its Ceiling,
  with a slot);
- an available Account whose sign-in the Runtime says ends within 3 days (`credentialExpiresAt` of the Account, when
  the Host reports it).

When all is well it prints nothing and exits 0 (no Ready Item is not a finding). Otherwise it writes each finding to
stderr, sends one line to the notifier (below), and exits 1. With `checkAt`, `system init` also writes
`system-schedule-<name>-check.service` (no wait for the Host: a Host that is down is what it reports) and
`system-schedule-<name>-check.timer`; enable it like the pass timer.

## The pass report and its notifier

When a pass takes an Item or hits an error, it generates a Markdown report from the Works' records (per Item its Works,
outcome, Account, tokens, cache-read share and cost, then skipped Items and errors), stores it as a `local-private`
Artifact and prints its ID on stdout. Read it with `system artifact cat <id>`.

A pass exits non-zero when the Host does not answer, a repository's status cannot be read, no free Account is
available, or an Item it took ended failed. On the `--schedule` path, the pass asks the Host for up to 5 minutes before
giving up, and every failure (the Host does not answer, the Schedule file does not parse, or an uncaught error) sends
one notifier line with the cause and exits 1. A pass that finds an earlier pass still running is not a failure (exits 0)
and sends nothing.

To receive the one-line verdict (date, repositories, counts of merged, held, failed and skipped, report ID, and any
cause) on your phone or elsewhere, set one of these in the service's environment (for a systemd unit, an `Environment=`
or `EnvironmentFile=` drop-in via `systemctl --user edit system-schedule-<name>`, kept outside the repository; they are
the only place a secret may live):

- `SYSTEM_SCHEDULE_NOTIFY_URL`: an ntfy-style URL; the pass POSTs the one-line verdict to it (`text/plain`).
- `SYSTEM_SCHEDULE_NOTIFY_COMMAND`: a shell command run with the one-line verdict as `$1`.

The notifier runs for every pass that took an Item or failed, and for a failed `--check`, never for a pass that found
nothing Ready. A notifier that fails is reported on stderr and does not change the exit code. Without a notifier, the
report ID and errors still go to the journal.

## Removing the installed `system-night-session` units

The old model-caller launcher (`system-night-session`) has been deleted. If its user units are still installed on the
machine, remove them after enabling your Schedule timer:

1. Write your Schedule file (for example `~/.system/schedules/daily.yaml`), run `system init`, and enable it with
   `systemctl --user enable --now system-schedule-daily.timer`.
2. Stop and disable the old timer:

```sh
systemctl --user disable --now system-night-session.timer
```

3. Delete the old unit files (and any drop-in directory) and reload systemd:

```sh
rm -f ~/.config/systemd/user/system-night-session.service ~/.config/systemd/user/system-night-session.timer
rm -rf ~/.config/systemd/user/system-night-session.service.d
systemctl --user daemon-reload
```
