---
type: operations
status: active
reviewed: 2026-11-09
covers: [bin/system, bin/service.mjs, bin/update.mjs, packages/app/src/index.ts, packages/app/src/client.ts, packages/host/src/process.ts]
---

# Runbook

How to run the Host of the default home (`~/.dsh`) as a user service, and
what to do when it does not. The design is in [Host](../architecture/host.md#running-it).

The Host runs as a process and the CLI is its thin client: every command but
`init`, `update`, `host` and `doctor` talks to the Host on
`$DSH_HOME/system/host.sock`, so a Host must run for them.

## Install and start

System runs from an install under `~/.system` (`SYSTEM_INSTALL` for another
place), apart from any checkout you develop in:

```
~/.system/
  repo/                          a clone of the origin
  releases/<commit>/             one built install per commit of main; never edit one
  current -> releases/<commit>   the code the Host runs
  profile.yml                    this machine's Accounts and Effects: the Host's --patch
```

The store and the secrets stay in `$DSH_HOME/system` (`~/.dsh`, DSH's).
`system update` installs the newest commit of `main` ([Upgrading](#upgrading)).
`system init`, run from the install, links the profile to `current` and writes
the user unit, which it never enables or starts
([bin/README.md](../../bin/README.md)):

```
systemctl --user enable --now system
```

Run `system init` again after changing Node or `PATH` (the unit holds those of
the last init) or adding `profile.yml`. A development checkout runs as itself:
`bin/system host --supervise` with a `DSH_HOME` of its own, never the default
home while the installed Host runs.

To use System from a Claude Code session in any repository, register its MCP
server once for your user ([agents](#using-system-from-an-agent)):

```
claude mcp add --scope user system -- ~/.local/bin/system mcp
```

## Stop, restart, status

```
systemctl --user stop system       # SIGTERM: the Host stops and exits 0
systemctl --user restart system
systemctl --user status system
```

Whatever was running when the Host stopped is lost at the next start. A Worker
attempt cut short is dispatched again by the Host once its process is confirmed
gone; a lost attempt not confirmed gone, a verifier run or a publish or merge
effect waits for `system work run` or `retry`. (A
Host that stopped itself for new code waits for its attempts first; see
[Upgrading](#upgrading).)

## Upgrading

`system update [--wait <minutes>]` moves the install to the newest commit of
`main`, and only to code that passed its own checks on this machine:

- it fetches `main` (the commit already current is nothing to do), adds
  `releases/<commit>` and runs `corepack pnpm install --frozen-lockfile` and
  `corepack pnpm build` there;
- it checks that commit by a Work, `workflows/code-checks.yaml` on a task whose
  base is the commit, and prints the Work ID: the evidence, bound to the exact
  commit. A failed build or check leaves `current` where it was. With a
  `current`, the commit is checked as a change from the release that runs now,
  so `paths` selects the checks by the files that differ between the two
  releases; the first install checks the whole commit;
- it switches `current` (a new link renamed over it), then asks the Host as a
  client of the new code, which makes the Host drain and restart on it (below);
- if the Host does not run the new code within `--wait` (default 75 minutes,
  more than one attempt's time limit), it switches `current` back, and the
  unit's next start runs the code before. Releases other than the current one
  and the one before are removed.

While it upgrades the Host starts no new attempt and lets the running ones
finish (however long they take); Works can still be submitted: they wait. Then
it exits and restarts, and the Works held go on. The log lines, exit status,
retries and exit grace are in [the Host](../architecture/host.md#upgrading-on-new-code-d).

A command run meanwhile waits up to 3 s for the swap before it says the Host
is not running. A CLI of the new code can still read (`work show`, `work list`,
`workers`); a command that changes something says to retry once the Host has
restarted. `system host`'s log says what a draining Host waits for;
`systemctl --user restart system` stops it at once and interrupts the attempts.

A Host run from a development checkout also restarts itself on a build there,
but not while the `.building` file `corepack pnpm build` keeps at the checkout's
root exists; a failed build leaves it, so the Host stays on its code until a
build succeeds.

## Rollback

Point `current` at the release before (`ls ~/.system/releases`) and restart:

```
ln -sfn releases/<commit> ~/.system/current.new && mv -T ~/.system/current.new ~/.system/current
systemctl --user restart system
```

The restart interrupts running attempts; do it when `system work list` shows
none running. What the Host then runs again by itself, and what waits for
`system work run`, is in [Stop, restart, status](#stop-restart-status). A
release refuses a store whose records it does not know only if a later release
changed the record schema (`git diff <commit>..<later> --
packages/work/src/record.ts packages/artifacts/src` shows it).

## Changing the profile's config

An entry of the profile's own patch (`$DSH_HOME/profiles/system/cordis.patch.yml`,
or a `--patch` file) changes the bundle's `config` of that row instead of
replacing it (milestone B; [patches](../../patches/README.md)): objects merge
as JSON Merge Patch (RFC 7386, `null` removes a key), and a list of objects
with a `ref` (or `id`) merges item by item on it, as Kubernetes' strategic
merge patch does. So one account is changed, added or removed alone:

```yaml
- id: agents
  config:
    accounts:
      - ref: codex/default                # change: only what is named
        capabilities: [code-write, brainstorm.idea-b, research]
      - ref: web/chatgpt/second           # add
        runtime: web
        site: chatgpt
        capabilities: [research]
      - ref: claude-code/default          # remove
        $patch: delete
```

A list of names (such as `capabilities`) is replaced whole. `$patch: replace`
in the `config` takes it whole, as the overlay used to. `system workers` shows
the accounts that result.

The `verifiers` row's `checkEnv` gives every `code.required-checks` check
variables of the machine, on top of its minimal environment (`PATH`, `LANG`, a
throwaway `HOME`, `CI=1`). A repository whose toolchain lives under the user's
home, such as DNA (Rust, `rust-toolchain.toml`), needs it:

```yaml
- id: verifiers
  config:
    checkEnv:
      RUSTUP_HOME: /home/tan/.rustup
      CARGO_HOME: /home/tan/.cargo
      CARGO_TARGET_DIR: /home/tan/.cache/system-cargo-target
```

Names match `^[A-Z_][A-Z0-9_]*$`; `HOME`, `PATH` and `CI` cannot be set, and
the profile is refused if it tries. A `check-run@1` records the names it was
given, never the values. The same row's `maxConcurrentChecks` (default 2) is how many `code.required-checks` runs go at once on the machine; the others show as waiting for a check slot in `work show` and `system status`, and a lost run keeps its slot until its processes are gone.

## Attempts at once, and held slots

An `agents` account may carry `label`; name refs `<runtime>/<n>` (`claude-code/1`, `codex/1`, `web/chatgpt/1`), with `label` the name for people. A retired ref is never reused, and records keep it. Two accounts on one provider account are refused for the later one (`system workers` gives the reason); see the [agents README](../../packages/agents/README.md#account-identity).

**Renaming an Account.** Wait until no Work runs (nothing is stopped for it), then:

1. Edit the `ref` in `~/.system/profile.yml`.
2. Move the Account's directory under `~/.dsh/system` to the new name: `claude/<name>` (Claude Code's `claudeHome`), `codex/<name>` (Codex's `codexHome`), or `web/<site>/<name>` (the browser profile of a web Account). An Account that sets `claudeHome`, `codexHome` or `profileDir` itself keeps that path; move it only if you want it renamed.
3. Keep the credential names (`tokenRef`) as they are.
4. Restart the Host and check `system workers`: the new ref is `available`.

The old ref is retired: do not give it to another Account. Records keep it.

`system workers` also prints one `quota:` line under each account, e.g. `quota: 5h 18% (resets 23:03), 7d 10%, read 2 min ago`: the share used of the 5-hour and weekly windows, when they reset (local time) and when it was read. Reading never spends a model turn, and when it cannot be read the line says why (`quota: unreadable - ...`). See the [agents README](../../packages/agents/README.md#quota).

Each Account (an `agents` account such as `claude-code/default`) runs one
attempt at a time; other steps and Works that need it wait in the Host, unless
another Account offers the same capabilities and has a free slot, which takes
the step. `system work report` shows the time a Work waited for a slot
(`waitedForSlotMs`) and its rate-limited attempts (`rateLimitedAttempts`). Its
`failures` classify each failure, verdict, hold, failed publish and touch as an
Outside failure with its cause, or a failure of the change, from the recorded
reason ([GLOSSARY](../../GLOSSARY.md); patterns in `packages/work/src/outside.ts`). To allow
more, set `maxConcurrentAttempts` (a whole number of at least 1, else the account
is skipped and `system workers` says why) in the profile's `agents` row, then
restart the Host:

```yaml
- id: agents
  config:
    maxConcurrentAttempts: 1      # every account; default 1
    accounts:
      - ref: claude-code/default
        maxConcurrentAttempts: 2  # this account only
```

A web account always runs one attempt at a time: the row-wide value does not
apply to it, and an own value other than 1 makes it unavailable. Codex accounts
share one `auth.json`; with several attempts at once only the first refresh is
copied back.

A Host that stops with attempts running holds their Account slots until the
process is gone ([host.md](../architecture/host.md)). If a
slot never clears, find the process with `pgrep -fa claude` or `pgrep -fa codex`.

## The web account

A Worker that runs a step in the operator's signed-in ChatGPT web session
([PROP-0005](../proposals/PROP-0005-chatgpt-website-worker.md); options in the
[web-worker README](../../packages/web-worker/README.md)). It is
**not enabled by default**, in two steps in the profile's own patch
(`$DSH_HOME/profiles/system/cordis.patch.yml`), then restart the Host: turn on the
optional `web-worker` row, and add the account to the `agents` row (it is added to
the bundle's accounts, see above):

```yaml
- id: web-worker
  disabled: false
- id: agents
  config:
    accounts:
      - ref: web/chatgpt/default
        runtime: web
        site: chatgpt
        capabilities: [research, web-search, research.web]
```

Give a web account `research.web` so the research Workflow prefers it; without it the account is used like any other.

The ref is `web/<site>/<name>` with `<site>` equal to the entry's `site`, which picks the shipped UI map and the Site's
defaults (an unknown site is refused with the list of shipped sites: today `chatgpt`).

With the row off, `system workers` shows the account `unavailable` with the reason
"the web-worker row is disabled", and `system workers login` says the same.

It needs `Xvfb` (`apt install xvfb`) and a recent Chrome (and for `--remote` a VNC
server, see below). The Chrome is chosen, and a pinned one downloaded the first
time it is needed, as the [web-worker README](../../packages/web-worker/README.md)
says. `system workers` shows the account as `available` once Xvfb is found and
the Chrome path exists; that says nothing about the sign-in. It is `unavailable`
with a reason that names what is missing.

**Sign in, once.** Three ways:
- `system workers login web/chatgpt/default --cookies <file>`: a JSON export from
  a browser extension, or a Netscape `cookies.txt`, of chatgpt.com from your
  own signed-in browser. Delete the file yourself when done: it is as good as a
  password. Which cookies are kept: the [web-worker README](../../packages/web-worker/README.md).
- `system workers login web/chatgpt/default --remote`: for a server with no
  display, and for a Cloudflare challenge. See below.
- With neither, on a machine with a display: a window opens on the **Host's**
  `DISPLAY` (a user service has none unless you run
  `systemctl --user import-environment DISPLAY` and restart it). Sign in by hand.

Each prints `signed in`, or `not signed in:` and why (exit 1), never a cookie
value. Do not log in while an attempt of the account runs: Chrome holds the profile.

**Sign in over SSH (`--remote`).** On the server, as the user that runs the
Host:

```
system workers login web/chatgpt/default --remote
```

It prints three steps, for example:

```
1. On your own machine, open the tunnel (keep it running):
     ssh -L 41873:127.0.0.1:41873 me@server
2. Open this address in your browser:
     http://127.0.0.1:41873/<43 characters>/
3. Sign in and clear any check by hand, then press Save. ...
```

1. On **your own machine**, run the `ssh -L ...` line exactly as printed. The
   `user@host` part is the Host's user and its host name; replace the host with
   the name or address you reach the server by if they differ.
2. Open the URL in your browser. It shows the browser's private display; use
   it as a normal browser.
3. Sign in, and if a "verify you are human" check shows, clear it yourself.
   System never clicks it.
4. Press **Save**. The page says `Signed in` or `Not signed in: <why>`, and the
   command prints the same and exits 0 or 1. **Cancel**, Ctrl-C on the server,
   or 15 minutes end the session without saving.

`--remote` needs a VNC server on the Host's `PATH`: `x11vnc` (`apt install
x11vnc`) or TigerVNC's `x0vncserver` (`apt install tigervnc-scraping-server`);
without one the command fails at once, naming both. Without root, unpack the
packages into the home directory and put a wrapper script on the `PATH`.

**Account states.** `system workers` shows any state but `ready` as `unavailable`
with what to do; the states and quarantine rules are in the
[web-worker README](../../packages/web-worker/README.md).

- `needs-sign-in`: log in again (`--remote` or `--cookies`), then
  `system workers recheck web/chatgpt/<name>`; a successful `--remote` rechecks itself.
- `challenged`: a CAPTCHA or Cloudflare challenge showed. System never solves
  one: run `system workers login web/chatgpt/<name> --remote`, clear it in the
  viewer, press **Save**, `recheck`, and retry the Work.
- `cooling`: eligible again at the time shown; `recheck` ends it early. If it keeps coming back, stop using the Account for a while.
- A failure of the Host's (Chrome did not start, a page timeout) never changes the state; look at the Host. No prompt is resent automatically: a retry is `work retry`.

The attempt's `screenshot` partial output shows the page:
`system work show <id>`, then `system artifact cat <id> > shot.png`.

**The profile** is `$DSH_HOME/system/web/<site>/<name>` (or `profileDir`), a
Chrome user-data directory created mode 0700. It holds the live session: treat
it as a password. Keep it out of backups, sync and version control, never copy
it to another machine or hand it to another Worker, and delete the directory to
sign the account out of System. An attempt that finds the page in an unknown
state fails after the `load` timeout with that reason and a screenshot.

## The web canary

`tools/web-canary` is the reliability gate of the `web` Workers read from
System's own records: it stores the fixed Research question ("What is the capital
of France? Cite the English Wikipedia article that says so
(https://en.wikipedia.org/...).", a page the citation verifier can read, so the
canary measures the Website Worker and not a third-party site) as a `task@1` (the
same Artifact ID every time) and runs `workflows/research.yaml` on it once on
each registered `web` Account, with `system work submit --worker <ref>`, and
prints one line per Work: Account, Work ID, status, seconds.

```
tools/web-canary                              # run it now
tools/web-canary --task                       # the canary Task's Artifact ID
tools/web-canary --report [--since <ISO>]     # read the records
```

`--report` classifies the finished Works on the canary Task and prints the gate
(`gate: holds` or `does not hold`, exit 3). Run it after each merge into
`web-workers`; the timer does so every six hours.

Install the timer as a user unit (it needs the Host running; it is not installed
by `system init`):

```
mkdir -p ~/.config/systemd/user
for u in service timer; do
  sed -e "s|@REPO@|$PWD|g" -e "s|@NODE@|$(command -v node)|" -e "s|@PATH@|$PATH|" \
    packages/bundle/system-web-canary.$u > ~/.config/systemd/user/system-web-canary.$u
done
systemctl --user daemon-reload
systemctl --user enable --now system-web-canary.timer
```

Read it with `systemctl --user list-timers system-web-canary` and
`journalctl --user -u system-web-canary`; start a run with
`systemctl --user start system-web-canary`, stop the series with
`systemctl --user disable --now system-web-canary.timer`. Changing the
question's text starts a new series (a new Task ID).

## The scheduled session's prompt

`tools/night-session.md` is the prompt of the scheduled session (PLAN 3c, ss-1, ss-8).
The session is a Claude Code caller of System, not part of it: for each
repository it is given (System by default) it reads `status`, takes the
`todo` Items in STATUS order, and for each calls `item_claim`, `task_new`
(with `repository`, `ref` `dev` and `item`), `work_submit` with the
repository's `workflows/develop.yaml` (`hygiene.yaml` when the Item says
behaviour is unchanged) and waits with `system work wait <work> --timeout 1.5`
in Bash, again on exit 4. It stops after 6 Items in a night (no money cap for
now), skips an Item whose Work is held or whose Works failed twice and says why,
never writes Items, never approves, denies, retries a held step or releases, and
stores the night report (below).

It uses the `system` MCP server's tools (shown to Claude Code as
`mcp__system__<tool>`, such as `mcp__system__work_submit`: `status`, `item_claim`, `task_new`, `work_submit`,
`work_show`, `work_report`, `work_list`, `artifact_show`,
`artifact_cat`), not `system work submit --no-run` (which only admits a Work, so
nothing would run) and not a followed `system work submit` (which outlives a
Bash call). `work_submit` runs the Work and returns its record at once. Task text
goes as a tool argument, never through a shell string. `--timeout` of `work wait` is in minutes: 1.5 is 90
seconds, inside a Bash call.

`packages/bundle/system-night-session.sh` (what the service starts) runs
`claude -p` with `--allowedTools` naming exactly those tools, `Bash(system work wait:*)`,
and nothing else (no `artifact_put`, no notifier: the launcher does those, below). Nothing there approves, denies, cancels, retries or releases, so a session
that tried would be refused by permission as well as by the prompt, and it
writes no file. Anything else is refused, because `claude -p` has no one to ask.
`packages/app/tests/night-session.test.ts` checks that every `system` command and
option and every MCP tool the prompt names exists, and
`packages/bundle/tests/night-session-units.test.ts` that the allowlist is exactly
what the prompt uses; `packages/bundle/tests/night-session-launcher.test.ts` runs the
launcher with a fake `claude` and `system`; `tests/night-session.test.ts` follows the prompt's sequence
(claim, task_new, work_submit, work wait, work_report) for one Item
against a real Host with fake Workers. What the tests cannot show is that your
`claude` accepts these rules, so do one real run once before enabling the timer,
with no `todo` Item (or only an Item you are happy to have worked):
`packages/bundle/system-night-session.sh` in a checkout after the Host answers
(`systemctl --user start system-night-session` does the same under the unit), and
read the journal or output: it should find no `todo` Item, store a report and
print its ID, and `system artifact cat <id>` should read it. A "permission"
refusal in the output names a rule to fix in the script.

### The night report and its notifier

The session's final answer is the report, in Markdown: the Works of the night
(outcome, Account and cost from `system work report`), Items done, Items skipped
and why, Works on the Host that name no Item (where quota went), Items it
proposes, and the exact release commands for you. The launcher
(`system-night-session.sh`) runs `claude -p ... --output-format text`, writes the
answer to a file, stores it with `system artifact put <file> --media-type
text/markdown` and prints the Artifact ID. If `claude` fails or answers nothing,
it still stores a short report saying so (and exits with `claude`'s status).
Read it with `system artifact cat <id>`.

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
service first waits up to 5 minutes for the Host (`bin/system doctor` exits 0);
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
`journalctl --user -u system-night-session`; run one now with
`systemctl --user start system-night-session`; stop the series with
`systemctl --user disable --now system-night-session.timer` (and a night
already running with `systemctl --user stop system-night-session`). To change
the time, edit `OnCalendar=` in `~/.config/systemd/user/system-night-session.timer`,
then `systemctl --user daemon-reload` and `systemctl --user restart system-night-session.timer`.

## The dev branch

System merges a Work's change into `dev` only through its merge queue
([effects README](../../packages/effects/README.md), [ADR-0008](../decisions/ADR-0008-dev-integration-branch.md)).
A conflict fails the publish step naming the files; a check that fails on the
merge names it in the reason. Do not require pull requests in `dev`'s branch
protection: the push would be refused.

## Another home

Only `~/.dsh` gets the unit. For another `DSH_HOME`, run
`DSH_HOME=<home> system host` in a terminal (Ctrl-C stops it); keep the path
short, a socket path is limited to about 100 bytes.

## Logs

`journalctl --user -u system` (add `-f` to follow).

## Host not running

The CLI prints one line and exits 1 when nothing answers at
`$DSH_HOME/system/host.sock`:

```
system: the System Host is not running for <home>: systemctl --user start system (or run: system host)
```

1. `systemctl --user status system`: is it `active`? If not, start it.
2. If it failed, read `journalctl --user -u system -e`. A missing `claude`,
   `codex` or `git` is a `PATH` captured at init that no longer holds: run
   `system init` again from a shell that has them.
3. `Node >=24.9.0` errors: `bin/system` runs the newest Node 24 under
   `~/.nvm/versions/node/` by itself; with none, install one (`nvm install 24`).
4. `another Host already runs for <home>`: one is running, perhaps one in a
   terminal. Stop it; there is one Host per home.

## The Host is not answering

```
system: the System Host for <home> is not answering (...): see docs/operations/runbook.md, "The Host is not answering"
```

The socket accepts connections but a call got no answer in 10 seconds. A call
that changes something (`submit`, `run`, `retry`, `cancel`, `approve`) is sent
once more with the same `commandId`, so the Host does it once: look at
`system work list` before sending it again yourself.

Every command but `system work wait` fails at once with this. `system work wait`
keeps waiting with a backoff; after 10 minutes unreachable (or its `--timeout`)
it exits **6**, never a success, and the Works may still be running: run it
again or `system work list`. Its exits are in the
[app README](../../packages/app/README.md).

1. `systemctl --user status system` and `journalctl --user -u system -e`: is
   the Host alive, and busy or stuck?
2. `system doctor` boots DSH beside the Host and says whether it answers.
3. If it is stuck, `systemctl --user restart system`. Whatever was running is
   lost; a Worker attempt is dispatched again by the Host once its process is
   confirmed gone, and anything else waits for `system work run` or `retry`.

## A check the base fails too

A required check that fails on a change is run again on its base commit. When
the base fails it too, the failing checks are run once more on the change and on the
base (sc-13), because a loaded machine fails checks the change did not break: a pass on the
change's re-run gives `pass`, a pass on the base's gives `fail` (the step reopens as for any
failure). Only when the checks still fail on both is the `checks` verdict `inconclusive` (reason
`<check>: the base fails it too`, `also on a re-run once`, evidence of all the runs) and the Work is **held**
before `publish`, not retried. `system work show <id>` shows the reason: look
at the base runs (`system work show` lists all of them). `system work approve <id> --reason ...` lets it publish and
merge; `system work deny` fails it.


## A check that fails again on the same change

When a failing check reopens `implement` and `implement` changes nothing, the
check runs once more on that same change (`retry.rerunUnchanged`, sc-9;
[the vocabulary](../architecture/workflow-composition.md#the-implemented-vocabulary-systemworkflowv1)).
If the second run passes, the Work goes on and `system work show <id>` notes
the check as flaky. If it fails again, the verdict is `inconclusive` with both
runs as evidence and the Work is **held**: `system work approve <id>` lets it
go on, `system work deny` fails it, and `system work retry <id> --step <verify
step>` asks the check again. This re-run (sc-9) is separate from the verifier's own one re-run of an
inconclusive verdict (sc-13, [above](#a-check-the-base-fails-too)).

## Following a Work, and detaching

Commands that wait follow the Work, and Ctrl-C detaches without touching it;
only `system work cancel` cancels a Work. Exit codes and polling are in the
[app README](../../packages/app/README.md). Read what happened with
`system work show <id>`.

While Worker attempts run, `work show` also prints `live` (start, last
activity, what the Runtime last reported). An attempt quiet for `stallMinutes`
(10 by default; the `work` row's config) is `stalled: true`: a notice, not a
verdict. `live` is never recorded.

## The status of a project

A repository lists its planned work in a `STATUS.md` at its root: one line per
**Item**, `- [ ] <id> <title>` (`- [x]` when done), with an id such as `df-3`
(see [GLOSSARY](../../GLOSSARY.md)). A line that does not parse is skipped and
reported by `system status` as a `note:`.

```
system task new --text "..." --repo . --ref dev --item df-3   # prints the Task ID alone
system claim df-3 [--repo .] [--force]   # before a Work exists: shown as doing
system status [--repo <path>] [--state todo|doing|done] [--item <id>]
```

`status` derives each Item's state from git and the Work records; `claim`
and `status` are in the [app README](../../packages/app/README.md). While a
Work for an Item runs or is held, `work submit` for the same Item is refused,
naming that Work; `--force` allows parallel work on purpose. A Task that names
an Item carries the Item's line and its earlier Works' outcomes in its context.
`task new --item` is refused when the Item has no line in `STATUS.md` on `dev`.
Works do not edit `STATUS.md`: done is derived.

## Using System from an agent

`system mcp` lets an agent session such as Claude Code use System's agent
operations as MCP tools. It runs without DSH and talks to the running Host, so
start the Host first, then add the server:

```
claude mcp add system -- system mcp
```

The server sends `instructions` in its initialize result, which the client puts
in the session's context, so a session in any repository knows when to use
System, what a repository needs and the steps, without reading these docs.
The Workflow it names for any change to a repository is `develop.yaml`; a cleanup
that keeps behaviour uses `hygiene.yaml`. The others it names are `research.yaml`,
`brainstorm.yaml` and the Sub-workflow `code-checks.yaml`.

A Workflow submitted through `work.submit` may use Sub-workflows without
sending them: the Host reads each from `workflows/` at the input Task's base
commit, else beside its own code.

The session is an agent: it may use every agent operation on every Work, store
Tasks and files, and list the Workers.

Each Work is also an MCP resource, `system://work/<id>` (`work.show`); subscribe
to it (`resources/subscribe`) to be woken when the Work ends, is held, waits for
approval or stalls, then read `work.events` from your last `seq`.

It cannot approve or deny, set credentials, sign an
account in, or merge into `main`. When a check failed for a reason outside the
change, it tells the operator: only a human runs
`system work retry <work> --step checks.checks`.

## Errors

An error is one line, `system: <message>`, never a stack. `SYSTEM_DEBUG=1`
prints the stack as well.
