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
  commit. A failed build or check leaves `current` where it was. With a
  `current`, the commit is checked as a change from the release that runs now
  (`system task new --against`: the base's `parent`), so `paths` selects the
  checks by the files that differ between the two releases (`web` runs only
  when the Website Worker, its driver or its test changed), from the new
  commit's own `.system/checks.yaml`; the first install checks the whole
  commit. The log line names the release it compared with and the checks the
  verifier skipped;
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

A web account is one Chrome profile and always runs one attempt at a
time: the row-wide value does not apply to it, and an own value other than 1
makes it unavailable.

Codex accounts share one `auth.json`; with several attempts at once only the
first refresh is copied back.

A Host that stops with attempts running leaves them lost at the next start, and
their Account slots **held** while their process may still run. An agent attempt
is gone when its pid file (`$DSH_HOME/system/attempts/<attempt>.pid`) is absent or
names no live process. The Host checks at start and again when a waiting Work
has nothing of its own running, so a held slot clears after `system work run`
once the process is gone. If it never does, a process is still alive: find it
with `pgrep -fa claude` or `pgrep -fa codex`.

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
        capabilities: [research, web-search]
```

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

The browser is never headless: it runs on your `DISPLAY`, or on its own invisible Xvfb (PROP-0005).

**Sign in, once.** Three ways:
- `system workers login web/chatgpt/default --cookies <file>`: a JSON export from
  a browser extension, or a Netscape `cookies.txt`, of chatgpt.com taken from
  your own signed-in browser. The CLI reads it once and sends it to the Host;
  only chatgpt.com and openai.com cookies are kept, a session cookie gets a
  30-day lifetime, and your file is left as it is: delete it yourself when done,
  because it is as good as a password.
- `system workers login web/chatgpt/default --remote`: for a server with no
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
2. Open the URL in your browser. It shows the whole screen of the browser's
   private display (every tab, any popup), scaled to your window; click, scroll
   and type in it as in a normal browser. Anything without the long token in
   the address gets `404`.
3. Sign in, and if a "verify you are human" check shows, clear it yourself.
   System never clicks it.
4. Press **Save**. The page says `Signed in` or `Not signed in: <why>`, and the
   command prints the same and exits 0 or 1. **Cancel**, Ctrl-C on the server,
   or 15 minutes end the session without saving.

`--remote` needs a VNC server on the Host's `PATH`: `x11vnc` (`apt install
x11vnc`) or TigerVNC's `x0vncserver` (`apt install tigervnc-scraping-server`);
without one the command fails at once, naming both. noVNC and `ws` come with
System. Without root, unpack the packages into the home directory and put a wrapper
script for `x11vnc` on the Host's `PATH`.

**Account states.** Each `web` Account has a state in `$DSH_HOME/system/web/<site>/<name>/state.json`, and `system workers` shows
any state but `ready` as `unavailable` with what to do; Works needing the Account go to another one, or fail with "no enabled Worker
provides" when there is none. Each change is one line in the Host log.

- `needs-sign-in`: a sign-in wall, the login page or "Session ended, invalid_state" showed. Run `system workers login web/chatgpt/<name> --remote`
  (or `--cookies`), then `system workers recheck web/chatgpt/<name>`; a successful `--remote` does the recheck itself.
- `challenged`: a Cloudflare or CAPTCHA challenge showed. Clear it by hand as below, then `recheck`. Nothing else leaves it.
- `cooling`: a site error or a suspected rate limit; it is eligible again at the time shown (2 minutes, then 5 after consecutive ones;
  `cooldownSeconds`), a success clears it, and `recheck` ends it early. If it keeps coming back, stop using the Account for a while.
- A failure of the Host's (Chrome did not start, a page timeout while the Host's load is high) never changes the state; look at the Host.
  No prompt is resent automatically: a retry is `work retry`.

The attempt's `screenshot` partial output shows what the page looked like:
`system work show <id>`, then `system artifact cat <id> > shot.png`.

**A CAPTCHA or Cloudflare challenge.** The attempt fails with `a CAPTCHA or
Cloudflare challenge is showing`; System never types into or solves one, and
retrying at once will meet it again. Clear it by hand, in the profile the
attempts use: run `system workers login web/chatgpt/default --remote` (as above),
pass the check in the viewer, press **Save**, and retry the Work. The check
stays cleared as long as `cf_clearance` lives, which Cloudflare decides. If it
reappears, repeat the same steps. If it keeps coming back, slow down or stop
using the account for a while; an automated session is against OpenAI's Terms of
Use, a risk the operator accepted for their own account.

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
same Artifact ID every time) and runs `workflows/research.yaml` on it, citation check included, once on
each registered `web` Account, one after the other, with
`system work submit --worker <ref>`. It prints one line per Work: Account, Work
ID, status, seconds. Nothing is stored outside System's records.

```
tools/web-canary                              # run it now
tools/web-canary --task                       # the canary Task's Artifact ID
tools/web-canary --report [--since <ISO>]     # read the records
```

`--report` reads the finished Works whose input is the canary Task and classifies
each as **passed**, **worker-failed** (the line names the stage and reason),
**verifier** (the citation check held or failed) or **other**. Per Account and in
total it prints the counts, the median and p95 of the `launch` and `wait` stages,
the models and the target each attempt had, and `gate: holds` or `gate: does not
hold (...)`: at least 50 runs over both Accounts and at least 95% passed. The
canary asks `tier.standard`, so only runs of that target and of the current
question count; the others are shown apart as an older version. It exits 3 when
the gate does not hold. Run it after each merge into `web-workers`; the timer
does so every six hours.

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

Read it: `systemctl --user list-timers system-web-canary`, `journalctl --user -u
system-web-canary` for the lines of the last runs, and `tools/web-canary --report`
for the numbers. Start a run now with `systemctl --user start system-web-canary`;
stop the series with `systemctl --user disable --now system-web-canary.timer`.
A Work that fails stays a record: the report counts it, and `system work show <id>`
says why. Changing the question's text starts a new series (a new Task ID); the tool keeps the
earlier texts to report them as older versions.

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

## The status of a project

A repository lists its planned work in a `STATUS.md` at its root: a heading,
`Aim:` and one to three lines, then one line per **Item**,
`- [ ] <id> <title>` (`- [x]` when done). An id is lower case and ends in a
number, such as `df-3` or `dna-13`. Keep it near 100 lines and link details.
A line that does not parse is skipped and reported by `system status` as a
`note:`.

```
system task new --text "..." --repo . --ref dev --item df-3
system status [--repo <path>] [--state todo|doing|done] [--item <id>]
```

`status` prints one line per Item, from the tip of `origin/dev` (else the local `dev`) of the repository (git,
not the working tree; it never fetches, and the `note:` line names the ref and its age) and the Work records: `done` is `[x]` in `STATUS.md`,
with the last Work and Artifact for the Item; `doing` is a Work whose Task
names the Item and that is running or held (its ID, step, Account, since when,
and the live progress the Host keeps, or why it is held); `todo` is `nobody`.
Read a Work by its ID for details. The MCP tool `status` answers the same.

While a Work for an Item runs or is held, `work submit` for the same Item is
refused, naming that Work and its Account. `--force` (`force: true`) allows
parallel work on purpose. A Task that names an Item is read with the Item's
line and, for its last three earlier Works, their end reason, Task ID, change
Artifact and commit, and each failed verdict's full reason and evidence IDs added
to its context, so a new session or Worker can carry on from the status alone. The change that finishes an Item ticks it in `STATUS.md`, in the same
pull request.

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

A Workflow submitted through `work.submit` may use Sub-workflows without
sending them: the Host reads each from `workflows/` at the input Task's base
commit, else beside its own code.

The session is an agent: it may use every agent operation on every Work, store
Tasks and files, and list the Workers.

Each Work is also an MCP resource, `system://work/<id>`; reading it
gives `work.show`. To be told instead of polling, subscribe to it
(`resources/subscribe`): the server sends `notifications/resources/updated`
when the Work becomes terminal, is held, waits for approval, or one of its
attempts stalls. A notice only wakes the session: read the Work's events with
`work.events` from your last `seq`. A session that was away misses no event,
only the wake-up.

It cannot approve or deny, set credentials, sign an
account in, or merge into `main`. When a check failed for a reason outside the
change, it tells the operator: only a human runs
`system work retry <work> --step checks.checks`.

## Errors

An error is one line, `system: <message>`, never a stack. `SYSTEM_DEBUG=1`
prints the stack as well.
