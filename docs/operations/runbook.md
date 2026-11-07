---
type: operations
status: active
reviewed: 2026-11-07
covers: [bin/system, bin/service.mjs, packages/app/src/index.ts, packages/app/src/client.ts, packages/host/src/process.ts]
---

# Runbook

How to run the Host of the default home (`~/.dsh`) as a user service, and
what to do when it does not. The design is in [Host](../architecture/host.md#running-it).

**Status:** release R1. The Host runs as a process and the CLI is its thin
client: every command but `init`, `host` and `doctor` talks to the Host on
`$DSH_HOME/system/host.sock`, so a Host must run for them. The old mode, where
each command ran Work in its own process, is gone.

## Cutover to the Host (R1)

Do these in order, on the default home. For another home, set `DSH_HOME` and
run `system host` in a terminal instead of step 4.

1. **No old `system` process is running.** The old mode left one DSH process per
   command, and a Work it was running would be written twice.
   ```
   pgrep -af -- '--profile system' ; pgrep -af 'bin/system'
   ```
   Both print nothing (a `pgrep` matching only itself does not count). If a
   `system work run` or `retry` of the old mode is still going, let it finish
   or `kill` it, and run `system work list` after the cutover to see what was
   left interrupted.
2. **Back up the store.** With nothing running, copy it with its WAL files:
   ```
   mkdir ~/system-backup-$(date +%F) && cp -a $DSH_HOME/system/state.sqlite* ~/system-backup-$(date +%F)/
   ```
   (`$DSH_HOME` is `~/.dsh` by default). Keep the copy until a Work has run
   through the Host.
3. **`system init`** from a shell that has `claude`, `codex`, `git` and `node`
   on its `PATH`: it refreshes the profile and writes the unit.
4. **`systemctl --user enable --now system`** starts the Host now and at every
   login.
5. **Delete the old control files.** The Host ignores them and never deletes
   them:
   ```
   rm -f $DSH_HOME/system/control/*.lock $DSH_HOME/system/control/*.takeover \
         $DSH_HOME/system/control/*.written $DSH_HOME/system/control/*.cancel
   rmdir $DSH_HOME/system/control
   ```
6. **`system doctor`** reports every required row mounted, the storage probe
   passing and `host: answering`. Then `system work list` shows the old Works.
   A Work that was `running` when the old mode stopped stays so until
   `system work run <id>`.

## Rollback

To go back to the previous release, in this order:

1. **Stop the Host first:** `systemctl --user disable --now system`. Stopping
   it kills the attempts it started; whatever was running is left interrupted.
2. **Check that no attempt is still running:**
   ```
   systemctl --user status system      # inactive (dead)
   pgrep -af 'system host|claude|codex' # nothing from this home
   ```
   Kill a leftover attempt by hand; a second writer must not start with one
   still running.
3. **Check out the previous release** in the System checkout, then
   `corepack pnpm install --frozen-lockfile && corepack pnpm build` and
   `system init` again.

**The store format is unchanged by R1:** the DSH storage units `system_work` and
`system_artifacts` stay at version 1, and the Work record and the Artifact
envelope schemas are the same as before R1
(`git diff <release before R1> -- packages/work/src/record.ts packages/artifacts/src`
shows what a release changed; R1 itself changed neither). Nothing needs
converting, so a rollback keeps the Works. One earlier addition matters when
the previous release is older than the Host (H2): a Work changed through a
command carries an optional `receipts` field, which the strict record schema of
a release before H2 refuses at open. Count them:
```
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare(\"select count(*) as n from u_system_work_work where value like '%\\\"receipts\\\"%'\").get().n)" $DSH_HOME/system/state.sqlite
```
`0` means the older release opens the store. Otherwise restore the backup of
cutover step 2, which loses the Works changed since.

## Install and start

`system init` writes `~/.config/systemd/user/system.service`, runs
`systemctl --user daemon-reload` and `loginctl enable-linger $USER`, and prints
the two commands that turn it on. It never enables or starts the service:

```
systemctl --user enable --now system
```

`system init --no-service` (or `SYSTEM_NO_SERVICE=1`) skips all of this. Run
`system init` again after moving the checkout, changing Node or changing
`PATH`: the unit holds the Node binary and the `PATH` of the last init.

## Stop, restart, status

```
systemctl --user stop system       # SIGTERM: the Host stops and exits 0
systemctl --user restart system
systemctl --user status system
```

Whatever was running when the Host stopped is lost at the next start and is
left interrupted; nothing runs again until `system work run` or `retry`.

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
`$DSH_HOME/profiles/system/cordis.patch.yml`, replacing `accounts` with the
bundle's accounts plus this one), then restart the Host:

```yaml
- ref: chatgpt-web/default
  runtime: chatgpt-web
  capabilities: [research, web-search]
```

It needs Google Chrome (`/usr/bin/google-chrome`, or `executablePath`) recent
enough for chatgpt.com. `system workers` shows it as `available` once Chrome is
found; that says nothing about the sign-in.

**Sign in, once.** Either:
- `system workers login chatgpt-web/default --cookies <file>`: a JSON export from
  a browser extension, or a Netscape `cookies.txt`, of chatgpt.com taken from
  your own signed-in browser. The CLI reads it once and sends it to the Host;
  only chatgpt.com and openai.com cookies are kept, a session cookie gets a
  30-day lifetime, and your file is left as it is: delete it yourself when done,
  because it is as good as a password.
- With no `--cookies`, on a machine with a display: a window opens on the
  **Host's** `DISPLAY` (a user service has none unless you run
  `systemctl --user import-environment DISPLAY` and restart it). Sign in by hand;
  it waits up to ten minutes. This machine has no display, so use cookies.

Either way it then loads the page and prints `signed in`, or `not signed in:`
and why (exit 1). It never prints a cookie value. Do not log in while an attempt
of the account runs: Chrome holds the profile.

**A sign-in wall.** An attempt that fails with `the page shows a sign-in wall`
means the session ended (a sign-out, a password change, an expired cookie). Run
the login again. The attempt's `screenshot` partial output shows what the page
looked like: `system work show <id>`, then `system artifact cat <id> > shot.png`.

**A CAPTCHA or Cloudflare challenge.** The attempt fails with `a CAPTCHA or
Cloudflare challenge is showing`; System never types into or solves one, and
retrying at once will meet it again. Clear it by hand: stop the Host, open
Chrome on the profile with a display
(`google-chrome --user-data-dir=$DSH_HOME/system/chatgpt-web/default https://chatgpt.com/`),
pass the check, close it, start the Host, and retry. If it keeps coming back,
slow down or stop using the account for a while; an automated session is
against OpenAI's Terms of Use, a risk the operator accepted for their own
account.

**The profile** is `$DSH_HOME/system/chatgpt-web/<name>` (or `profileDir`), a
Chrome user-data directory created mode 0700. It holds the live session: treat
it as a password. Keep it out of backups, sync and version control, never copy
it to another machine or hand it to another Worker, and delete the directory to
sign the account out of System. An attempt that finds the page in an unknown
state fails after the `load` timeout with that reason and a screenshot.

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

## Goals and their budget

A Goal bounds what an agent session may spend. Write one at a terminal:

```
system goal new --aim "..." --scope "..." --attempts 10 --tokens 2000000
```

It prints the Goal's ID after you type the code it shows. Submit Works under it
with `system work submit ... --goal <id>`; each gets the Goal's context (the
Charter by default) as Task context. `system goal show <id>` and
`system work report <work>` show the spend: attempts, tokens (fresh input plus
output), and how many attempts had unknown usage.

Once the spend reaches the budget, `work submit --goal` fails with `the budget
of Goal ... is used up`; running Works finish. To go on, write a new Goal with
`--supersedes <old id>` and the raised budget; the old ID then resolves to it,
and the spend of the old versions still counts.

## Errors

An error is one line, `system: <message>`, never a stack. `SYSTEM_DEBUG=1`
prints the stack as well.
