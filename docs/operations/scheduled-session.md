---
type: operations
status: active
reviewed: 2026-11-26
summary: The nightly scheduled session: its prompt, repositories, report and timer.
covers: [packages/bundle/system-night-session.sh, packages/bundle/system-night-session.service, packages/bundle/system-night-session.timer]
---

# The scheduled session

Part of the [runbook](runbook.md).

## The scheduled session's prompt

`tools/night-session.md` is the prompt of the scheduled session (PLAN SS, section 1, ss-1,
ss-8): a Claude Code caller of System, not part of it. It reads `status`, takes
`todo` Items in STATUS order and works each through the MCP tools (`mcp__system__work_submit`
and the others) and `system work wait` (the prompt holds the sequence and its limits). It never approves,
denies, retries a held step or releases, and stores the night report (below).

`packages/bundle/system-night-session.sh` (what the service starts) runs
`claude -p` with `--allowedTools` naming exactly the tools the prompt uses, so
anything else is refused by permission, as `claude -p` has no one to ask. That one
`claude -p` runs inside a bubblewrap layer with only the caller socket, so it cannot
call an operation of the Operator's Authority ([ADR-0016](../decisions/ADR-0016-the-gate-is-enforced-by-reachability.md)
decision 5); without `bwrap` or user namespaces it does not run and the night report says the layer could not start.
The comment above `in_layer` in the script lists what is hidden and bound. To check the layer is on, run the script
with a `claude` on the `PATH` that runs `ls "$DSH_HOME/system"`: it shows `host.sock` only. The
tests under `packages/app/tests`, `packages/bundle/tests` and `tests` check the
prompt against the commands, the allowlist and a real Host. What they cannot
show is that your `claude` accepts these rules, so do one real run before
enabling the timer, with no `todo` Item: `packages/bundle/system-night-session.sh`
in a checkout after the Host answers. It should find no `todo` Item, store a
report and print its ID. A "permission" refusal names a rule to fix in the script.

### Which repositories the session works on

By default the session works on this repository. `SYSTEM_NIGHT_REPOS` (paths of
checkouts separated by `:`) names the repositories instead; the launcher passes
the list to the prompt in that order, and an entry that is not a git checkout is
reported (stderr, and the night report) and skipped. Before the prompt the
launcher runs `git fetch origin dev` in each of them (60 s at most); a failure is
logged on stderr and the night goes on with the `origin/dev` it has. There is no cap on the number of Items
(operator, 2026-11-26; it was 6 over all repositories). To add DNA, keep this repository first and set it in
the installed unit, with an `Environment=` line or a drop-in
(`systemctl --user edit system-night-session`):

```ini
[Service]
Environment=SYSTEM_NIGHT_REPOS=%h/workspaces/System:%h/workspaces/DNA
```

### The night report and its notifier

The session's final answer is the report, in Markdown (the prompt lists its
parts). The launcher stores it with `system artifact put` and prints the
Artifact ID; if `claude` fails or answers nothing it stores a short report
saying so. Read it with `system artifact cat <id>`.

To get the ID on your phone, set one of these in the session's environment
(for the timer, an `Environment=` or `EnvironmentFile=` line of the user unit,
kept outside the repository; they are the only place a secret may live):

- `SYSTEM_NIGHT_NOTIFY_URL`: an ntfy-style URL; the launcher POSTs the ID to it with `curl`.
- `SYSTEM_NIGHT_NOTIFY_COMMAND`: a shell command the launcher runs with the ID as `$1`.

A notifier that fails is reported on stderr and does not fail the night.

Neither is required: without one the ID only goes to the session's output, which
the timer sends to the journal (`journalctl --user -u <the session's unit>`).

### Running it every night

`packages/bundle/system-night-session.service` and `.timer` are templates (like
the web canary's; `system init` does not install them) that run
`claude -p` with that prompt (through `system-night-session.sh`) in this checkout, once a night at 01:00. The
service first waits up to 5 minutes for the Host (`system doctor` exits 0).
The check runs the installed `system` on the `PATH`, not the checkout's `bin/system`: a checkout build
older than the installed release fails doctor ("the client is older") and the night would never start;
the launcher's output, the report's Artifact ID, goes to the journal. `Persistent=false`:
a night missed while the machine was off is not run late. Nothing runs until
you enable the timer. `claude` must be on the `PATH` the install records and
signed in.

```
mkdir -p ~/.config/systemd/user
for u in service timer; do
  sed -e "s|@REPO@|$PWD|g" -e "s|@PATH@|$PATH|" \
    packages/bundle/system-night-session.$u > ~/.config/systemd/user/system-night-session.$u
done
systemctl --user daemon-reload
systemctl --user enable --now system-night-session.timer
```

Read it with `systemctl --user list-timers system-night-session` and
`journalctl --user -u system-night-session`; stop the series with
`systemctl --user disable --now system-night-session.timer`. To change the time
edit `OnCalendar=` in the installed timer, then `daemon-reload` and `restart` it.
