---
type: operations
status: active
reviewed: 2026-11-08
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
`system init`, run from the install, links the profile to `current`, writes
`~/.config/systemd/user/system.service` (`ExecStart=<node>
~/.system/current/bin/system [--patch ~/.system/profile.yml] host`), runs
`systemctl --user daemon-reload` and `loginctl enable-linger $USER`, and never
enables or starts it:

```
systemctl --user enable --now system
```

`system init --no-service` (or `SYSTEM_NO_SERVICE=1`) skips the unit. Run
`system init` again after changing Node or `PATH` (the unit holds those of the
last init) or adding `profile.yml`. A development checkout runs as itself:
`bin/system host --supervise` with a `DSH_HOME` of its own, never the default
home while the installed Host runs.

To use System from a Claude Code session in any repository, register its MCP
server once for your user ([agents](#using-system-from-an-agent)):

```
claude mcp add --scope user system -- ~/.local/bin/system mcp
```

### Moving to the install (DF0b)

From a Host started by hand in a checkout to the installed one, once:

1. While that Host runs, from a checkout of `main`:
   `<checkout>/bin/system update`. It builds the first release, checks it as a
   Work on that Host, and makes `current`.
2. `ln -sfn ~/.system/current/bin/system ~/.local/bin/system`.
3. Copy the `--patch` file that Host runs with to `~/.system/profile.yml`, and
   check its Effects (`base`, `mergeInto`).
4. When `system work list` shows nothing running, stop that Host (SIGTERM in
   its terminal) and wait for `system work list` to say it is not running.
5. `system init`, then `systemctl --user enable --now system`.
6. `system doctor` reports `host: answering`; `system work list` shows the
   Works.
7. Delete what the mode before the Host left, which the Host ignores:
   `rm -rf $DSH_HOME/system/control`.

## Stop, restart, status

```
systemctl --user stop system       # SIGTERM: the Host stops and exits 0
systemctl --user restart system
systemctl --user status system
```

Clients still connected do not delay the stop: the Host lets admitted calls
finish for 2 s, then closes every connection, and the CLI says the Host is not
running.

Whatever was running when the Host stopped is lost at the next start and is
left interrupted; nothing runs again until `system work run` or `retry`. (A
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
  commit. A failed build or check leaves `current` where it was;
- it switches `current` (a new link renamed over it), then asks the Host as a
  client of the new code, which makes the Host drain and restart on it (below);
- if the Host does not run the new code within `--wait` (default 75 minutes,
  more than one attempt's time limit), it switches `current` back, and the
  unit's next start runs the code before. Releases other than the current one
  and the one before are removed.

The Host's side of an upgrade:

1. It logs `system host: upgrading: this Host runs <old>, the code on disk is
   <new>; ...`, starts no new attempt, and lets the running ones finish
   (however long they take; it never interrupts one). Works can still be
   submitted and run: they wait.
2. With no attempt running it logs `stopped for the upgrade ... exiting 75`
   and exits 75. The unit restarts on that status (`RestartForceExitStatus=75`);
   `system host --supervise` runs it again (foreground, development: nothing
   else restarts it, and a SIGTERM ends the supervisor). A new Host that fails
   to start after an upgrade is tried again: the supervisor waits 2, 4 and
   8 s and logs each try; the unit every 5 s, at most 10 starts in 5 minutes.
   A process still alive 10 s after it stopped is made to exit, and logs
   `still running ... open: <resources>`: what held it, to report.
3. The new Host recovers as on any start and logs `continuing N Works held for
   the upgrade`: the Works whose runs waited at the gate go on, and nothing
   that was interrupted does.

A command run meanwhile waits up to 3 s for the swap before it says the Host
is not running. While the Host waits on a long attempt, a CLI of the new code
can still read (`work show`, `work list`, `workers`); a command that changes
something says the Host is upgrading, and to retry once it has restarted. If the Host is still draining, `system host`'s log says what it
waits for; `systemctl --user restart system` (or SIGTERM) stops it at once and
interrupts the attempts, as any stop does.

A Host run from a development checkout also restarts itself on a build there:
it looks at the code every 10 s. `corepack pnpm build` keeps a `.building`
file at the checkout's root while it runs, and the Host does not upgrade while
it is there; a failed build leaves it, so the Host stays on its code until a
build succeeds.

## Rollback

Point `current` at the release before (`ls ~/.system/releases`) and restart:

```
ln -sfn releases/<commit> ~/.system/current.new && mv -T ~/.system/current.new ~/.system/current
systemctl --user restart system
```

The restart interrupts running attempts; do it when `system work list` shows
none running. A release refuses a store whose records it does not know only if
a later release changed the record schema (`git diff <commit>..<later> --
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
      - ref: chatgpt-web/second           # add
        runtime: chatgpt-web
        capabilities: [research]
      - ref: claude-code/default          # remove
        $patch: delete
```

A list of names (such as `capabilities`) is replaced whole. `$patch: replace`
in the `config` takes it whole, as the overlay used to. `system workers` shows
the accounts that result.

## Attempts at once, and held slots

Each Account (an `agents` account such as `claude-code/default`) runs one
attempt at a time; other steps and Works that need it wait in the Host. To allow
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

Codex accounts share one `auth.json`; with several attempts at once only the
first refresh is copied back.

A Host that stops with attempts running leaves them lost at the next start, and
their Account slots **held** while their process may still run. An agent attempt
is gone when its pid file (`$DSH_HOME/system/attempts/<attempt>.pid`) is absent or
names no live process. The Host checks at start and again when a waiting Work
has nothing of its own running, so a held slot clears after `system work run`
once the process is gone. If it never does, a process is still alive: find it
with `pgrep -fa claude` or `pgrep -fa codex`.

## The chatgpt-web account

A Worker that runs a step in the operator's signed-in ChatGPT web session
([PROP-0005](../proposals/PROP-0005-chatgpt-website-worker.md); options in the
[agents README](../../packages/agents/README.md#the-chatgpt-web-runtime)). It is
**not enabled by default**: add it to the profile's `agents` row (for example in
`$DSH_HOME/profiles/system/cordis.patch.yml`; it is added to the bundle's
accounts, see above), then restart the Host:

```yaml
- ref: chatgpt-web/default
  runtime: chatgpt-web
  capabilities: [research, web-search]
```

It needs `Xvfb` (`apt install xvfb`) and a recent Chrome. System picks the
Chrome like System 1: `executablePath`, then `CHROME_PATH`, then a system Chrome
no older than the browser engine's Chromium (an old one, such as Chrome 95, is
passed over), then the pinned Chrome for Testing
(`packages/agents/chrome.lock.json`), which it downloads under
`$DSH_HOME/system/browsers` the first time an attempt or a login needs it
(about 150 MB; it is not done at startup, and a failed download names the
cause). It launches the browser as a genuine one: no automation flags, no
sandbox switch, a real keyring, and Chrome's `TMPDIR` shortened when yours is too
deep for its profile socket. `system workers` shows the account as `available`
once Xvfb is found and the Chrome path exists; that says nothing about the
sign-in. It is `unavailable` with a reason that names what is missing.

**The browser is never headless.** System always runs a real, headed Chrome, on
your `DISPLAY` if the Host has one and otherwise on its own invisible Xvfb that
it starts for each attempt and stops with it (also on cancel and on the time
limit). A real headed browser is closer to yours and is challenged less. There
is no `headless` option; an account that sets it is `unavailable`.

**Sign in, once.** Three ways:
- `system workers login chatgpt-web/default --cookies <file>`: a JSON export from
  a browser extension, or a Netscape `cookies.txt`, of chatgpt.com taken from
  your own signed-in browser. The CLI reads it once and sends it to the Host;
  only chatgpt.com and openai.com cookies are kept, a session cookie gets a
  30-day lifetime, and your file is left as it is: delete it yourself when done,
  because it is as good as a password.
- `system workers login chatgpt-web/default --remote`: for a server with no
  display, and for a Cloudflare challenge. See below.
- With neither, on a machine with a display: a window opens on the **Host's**
  `DISPLAY` (a user service has none unless you run
  `systemctl --user import-environment DISPLAY` and restart it). Sign in by hand;
  it waits up to ten minutes.

Each then loads the page and prints `signed in`, or `not signed in:` and why
(exit 1). It never prints a cookie value. Do not log in while an attempt of the
account runs: Chrome holds the profile.

**Sign in over SSH (`--remote`).** On the server, as the user that runs the
Host:

```
system workers login chatgpt-web/default --remote
```

It prints three steps, for example:

```
1. On your own machine, open the tunnel (keep it running):
     ssh -L 41873:127.0.0.1:41873 me@server
2. Open this address in your browser:
     http://127.0.0.1:41873/<64 hex characters>/
3. Sign in and clear any check by hand, then press Save. ...
```

1. On **your own machine**, run the `ssh -L ...` line exactly as printed. The
   `user@host` part is the Host's user and its host name; replace the host with
   the name or address you reach the server by if they differ.
2. Open the URL in your browser. It shows the ChatGPT tab; click, scroll and
   type in it as in a normal browser. Anything without the long token in the
   address gets `403`.
3. Sign in, and if a "verify you are human" check shows, clear it yourself.
   System never clicks it.
4. Press **Save**. The page says `Signed in` or `Not signed in: <why>`, and the
   command prints the same and exits 0 or 1. **Cancel**, Ctrl-C on the server,
   or 15 minutes end the session without saving.

The viewer listens on `127.0.0.1` only and no debugging port is opened; the
browser, its Xvfb and the server are stopped when the session ends. One remote
sign-in per account at a time, and not while an attempt of the account runs.

**A sign-in wall.** An attempt that fails with `the page shows a sign-in wall`
means the session ended (a sign-out, a password change, an expired cookie). Run
the login again. The attempt's `screenshot` partial output shows what the page
looked like: `system work show <id>`, then `system artifact cat <id> > shot.png`.

**A challenge that does not clear.** If "Verify you are human" appears again
however often you tick it, the Chrome is the first thing to check (`system
workers` shows its path; an old or automation-flagged build loops). System 1's
remote login uses VNC, so the clicks are real X input; the viewer here sends
them over CDP. If a challenge still loops with a current Chrome, that is the
difference left (PROP-0005); report it.

**A CAPTCHA or Cloudflare challenge.** The attempt fails with `a CAPTCHA or
Cloudflare challenge is showing`; System never types into or solves one, and
retrying at once will meet it again. Clear it by hand, in the profile the
attempts use: run `system workers login chatgpt-web/default --remote` (as above),
pass the check in the viewer, press **Save**, and retry the Work. The check
stays cleared as long as `cf_clearance` lives, which Cloudflare decides. If it
reappears, repeat the same steps. If it keeps coming back, slow down or stop
using the account for a while; an automated session is against OpenAI's Terms of
Use, a risk the operator accepted for their own account.

**The profile** is `$DSH_HOME/system/chatgpt-web/<name>` (or `profileDir`), a
Chrome user-data directory created mode 0700. It holds the live session: treat
it as a password. Keep it out of backups, sync and version control, never copy
it to another machine or hand it to another Worker, and delete the directory to
sign the account out of System. An attempt that finds the page in an unknown
state fails after the `load` timeout with that reason and a screenshot.

## The dev branch

Parallel Works each pass their own checks; their merges no longer break `dev`
together, because System merges a Work's change into an allowlisted base
(`mergeInto`) only through its merge queue: `dev` moves to exactly a commit whose required checks
passed, the change's merge with the current tip when `dev` has moved, by a
push with a lease. A conflict fails the publish step naming the files; a
check that fails on the merge names it in the reason. Do not require pull
requests in `dev`'s branch protection: the push would be refused.

## Another home

Only `~/.dsh` gets the unit. For any other `DSH_HOME`, run
`DSH_HOME=<home> system host` in a terminal; Ctrl-C stops it. A socket path is
limited to about 100 bytes, so keep that home's path short.

## Logs

```
journalctl --user -u system            # everything
journalctl --user -u system -f         # follow
```

The Host writes one line to stderr at start (`system host: started for <home>,
listening on <socket>`) and one at stop (`system host: stopped`).

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

A stale `host.sock` file is not a problem: the Host removes it once it holds
the home.

## The Host is not answering

```
system: the System Host for <home> is not answering (...): see docs/operations/runbook.md, "The Host is not answering"
```

The socket accepts connections but a call got no answer in 10 seconds. A call
that changes something (`submit`, `run`, `retry`, `cancel`, `approve`) is sent
once more with the same `commandId`, so the Host does it once: look at
`system work list` before sending it again yourself.

1. `systemctl --user status system` and `journalctl --user -u system -e`: is
   the Host alive, and busy or stuck?
2. `system doctor` boots DSH beside the Host and says whether it answers.
3. If it is stuck, `systemctl --user restart system`. Whatever was running is
   left interrupted; nothing runs again until `system work run` or `retry`.

## Following a Work, and detaching

`work submit`, `work run`, `work retry`, `approve` and `deny` return once the
Host has admitted the operation, then poll `work.events` every second until the
Work is terminal, and exit 0 (succeeded), 1 (failed), 3 (held) or 5
(cancelled). `work cancel --wait` follows the same way.

Ctrl-C **detaches**: the CLI prints `detached; <work> goes on in the Host` and
exits 0; the Work is not touched. With `--cancel-on-interrupt` Ctrl-C sends
`work.cancel` instead and follows the Work to its end; a second Ctrl-C then
detaches. Closing the terminal or killing the CLI never cancels a Work: only
`system work cancel` does. Read what happened with `system work show <id>`.

While Worker attempts run, `work show` also prints `live`: for each attempt
its start, last activity, elapsed and quiet seconds, and what its Runtime last
reported (Claude Code and Codex: turns, the last tool, tokens so far). An
attempt quiet for `stallMinutes` (10 by default; the `work` row's config) is
`stalled: true`, and watchers get one `work.changed` with `stalled: true`. A
stall is a notice, not a verdict: the attempt is not stopped. `live` is never
recorded; it is gone once the attempt reports.

## Goals and their budget

A Goal bounds what an agent session may spend. Write one at a terminal:

```
system goal new --aim "..." --scope "..." --attempts 10 --tokens 2000000
```

It prints the Goal's ID after you type the code it shows. Submit Works under it
with `system work submit ... --goal <id> --input <task>` (a Goal's Work needs
an input Task); each gets the Goal's context (the
Charter by default) as Task context. `system goal show <id>` and
`system work report <work>` show the spend: attempts, tokens (fresh input, cache
writes and output), and how many attempts had unknown usage.

A Work that is admitted and not finished counts as at least one attempt, so
many Works cannot be admitted before the first runs. Once the spend reaches the budget, `work submit --goal` fails with `the budget
of Goal ... is used up`; running Works finish. To go on, write a new Goal with
`--supersedes <old id>` (the newest version only) and the raised budget; the old ID then resolves to it,
and the spend of the old versions still counts.

## Using System from an agent

`system mcp` lets an agent session such as Claude Code use System's agent
operations as MCP tools. It runs without DSH and talks to the running Host, so
start the Host first. Write a Goal (above), then add the server with its ID:

```
claude mcp add system -- system mcp --goal <goal-id>
```

A Workflow submitted through `work.submit` may use Sub-workflows without
sending them: the Host reads each from `workflows/` at the input Task's base
commit, else beside its own code.

Without `--goal` the session is a plain agent: it may use every agent
operation on every Work.

With `--goal` it is an Orchestrator for that Goal. It may:

- submit Works, which always name its Goal, and run, retry and cancel them;
- read the Works of the Goal and of the Goals it supersedes, their events,
  reports and Artifacts;
- store Tasks and files, and list the Workers.

Each Work in scope is also an MCP resource, `system://work/<id>`; reading it
gives `work.show`. To be told instead of polling, subscribe to it
(`resources/subscribe`): the server sends `notifications/resources/updated`
when the Work becomes terminal, is held, waits for approval, or one of its
attempts stalls. With `--goal`
it also sends `notifications/resources/list_changed` when a new Work of the
Goal appears. A notice only wakes the session: read the Work's events with
`work.events` from your last `seq`. A session that was away misses no event,
only the wake-up.

**Replacing the Orchestrator session.** Its state lives in System, so a new
session takes over like a new Worker: it starts from `goal.brief` (`system goal
brief <goal>`: the Goal and its budget left, its Works with their current step
and live progress, its decisions, and what waits), and records each choice it
makes with `decision.add` (`system decision add`: question, options, choice,
reason, and the Artifacts it rests on, such as a synthesis or a review). A
decision is a record, never an authority. When a check failed for a reason
outside the change, it records that and tells the operator: only a human
runs `system work retry <work> --step checks.checks`.

It cannot approve or deny, store a conversation, set credentials, write a Goal,
sign an account in, or merge into `main`. It is refused, with the reason, any
call on another Goal's Works or their Artifacts. The budget of the Goal still
stops new Works.

## Errors

An error is one line, `system: <message>`, never a stack. `SYSTEM_DEBUG=1`
prints the stack as well.
