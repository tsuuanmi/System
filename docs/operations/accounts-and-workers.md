---
type: operations
status: active
reviewed: 2026-11-26
summary: The profile config, Accounts and their slots, and the Antigravity and web Workers.
covers: [packages/bundle/system-web-canary.service, packages/bundle/system-web-canary.timer]
---

# Accounts and Workers

Part of the [runbook](runbook.md).

## Changing the profile's config

An entry of the profile's own patch (`$DSH_HOME/profiles/system/cordis.patch.yml`,
or a `--patch` file) changes the bundle's `config` of that row instead of
replacing it; the merge rules are in the [patches README](../../patches/README.md).
So one account is changed, added or removed alone:

```yaml
- id: agents
  config:
    accounts:
      - ref: codex/default                # change: only what is named
        capabilities: [develop.implement, brainstorm.idea-b]
      - ref: web/chatgpt/second           # add
        runtime: web
        site: chatgpt
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

The names allowed, what a `check-run@1` records and `maxConcurrentChecks` (how many
`code.required-checks` runs go at once on the machine) are in the
[verifiers README](../../packages/verifiers/README.md); the others show as waiting for a check slot in `work show`
and `system status`.

## Attempts at once, and held slots

Account refs and labels, and the refusal of two accounts on one provider account, are in the
[agents README](../../packages/agents/README.md#account-identity).

**Renaming an Account.** Wait until no Work runs (nothing is stopped for it), then:

1. Edit the `ref` in `~/.system/profile.yml`.
2. Move the Account's directory under `~/.dsh/system` to the new name: `claude/<name>` (Claude Code's `claudeHome`),
   `codex/<name>` (Codex's `codexHome`), or `web/<site>/<name>` (the browser profile of a web Account). An Account that
   sets `claudeHome`, `codexHome` or `profileDir` itself keeps that path; move it only if you want it renamed.
3. Keep the credential names (`tokenRef`) as they are.
4. Restart the Host and check `system workers`: the new ref is `available`.

The old ref is retired: do not give it to another Account. Records keep it.

`system workers` also prints a `quota:` line under each account; see the
[agents README](../../packages/agents/README.md#quota).

`system workers` ends with one line that says whether there is room for more
parallel Works; `--repo <path>` (repeatable) adds the Ready Items of that
project's `STATUS.md`. It is information for you: the Host never picks an Item.

```
room: 3 of 8 Accounts free (slot and Headroom under Ceiling); Ready Items: System 5
```

An Account whose quota cannot be read counts as free when it has a free slot,
and is listed after the count as `quota unknown: <refs>`.

`system work report --since <ISO>` prints the headline: Items merged per
operator act. An operator act is an Intent the operator settled (store it with
`system intent new ... --settled-by-operator`, only when they said so in that
session; an Intent without the flag is not counted), an operator-confirmed
Artifact (`system confirm <artifact-id> --note <text>` stores a
`confirmation@1`), a release (a merge of `dev` into `main` seen in the
repository) or a human touch (retry, cancel, decision). The report shows the
parts and the ratio. Conversation with a caller session is not seen by System
and not counted.

Each Account (an `agents` account such as `claude-code/default`) runs one
attempt at a time; other steps and Works that need it wait in the Host, unless
another Account offers the same capabilities and has a free slot, which takes
the step. `system work report` shows the time a Work waited for a slot
(`waitedForSlotMs`) and its rate-limited attempts (`rateLimitedAttempts`). Its
`failures` classify each failure, verdict, hold, failed publish and touch as an
Outside failure with its cause, or a failure of the change, from the recorded
reason ([GLOSSARY](../../GLOSSARY.md); patterns in `packages/work/src/outside.ts`). The report counts
only Escaped defects that no later one supersedes and none withdraws: correct a recorded defect with
`system defect add ... --supersedes <defect-id>`, or retract it with `system defect withdraw <defect-id> --reason ...`.
To allow
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

## Antigravity Accounts

How to add an Antigravity CLI (`agy`) sign-in as Workers (flags and adapter details live in the
[adapters README](../../packages/agents/src/adapters/README.md)):

1. Install or update the CLI with `agy update` (1.5.18 or later; 1.4.6 lacked what System uses).
2. Create the Account's home `~/.dsh/system/antigravity/<name>` (mode 700) and sign in from a terminal:

   ```sh
   mkdir -m 700 -p ~/.dsh/system/antigravity/<name>
   cd ~/.dsh/system/antigravity/<name> && env -u DBUS_SESSION_BUS_ADDRESS HOME=$PWD agy
   ```

   Without the session bus, the login is stored as a mode 0600 file
   `.gemini/antigravity-cli/antigravity-oauth-token` in that home, never in the desktop keyring shared by
   all Accounts. A Google account that `agy -p /usage` calls "not eligible" must be verified in a browser
   first.
3. One sign-in is two Accounts ([GLOSSARY](../../GLOSSARY.md)): one with `"quotaGroup": "gemini"` and one
   with `"quotaGroup": "3p"` (Claude and GPT), both sharing `"agyHome": "antigravity/<name>"`. Each lists
   only the models of its group under `models` (`economy`, `standard`, `frontier`), checked with
   `HOME=~/.dsh/system/antigravity/<name> agy models`. Add the two account objects (JSON) to the
   `accounts` array of the `agents` row's `config` in `~/.system/profile.yml` (`- id: agents` followed by
   `  config: {...}`):

   ```json
   [
     {
       "ref": "antigravity/a1",
       "runtime": "antigravity",
       "agyHome": "antigravity/a1",
       "quotaGroup": "gemini",
       "capabilities": ["develop.implement"],
       "models": {
         "economy": "gemini-3.8-flash-medium",
         "standard": "gemini-4-hydrogen-medium",
         "frontier": "gemini-4-hydrogen-high"
       }
     },
     {
       "ref": "antigravity/a1-3p",
       "runtime": "antigravity",
       "agyHome": "antigravity/a1",
       "quotaGroup": "3p",
       "capabilities": ["develop.implement"],
       "models": {
         "economy": "claude-sonnet-4-6",
         "standard": "claude-sonnet-4-6",
         "frontier": "claude-opus-4-6-thinking"
       }
     }
   ]
   ```

4. Restart the Host (`systemctl --user restart system`) and check `system workers`: both refs are
   `available` with a `quota:` line.
5. System writes `<home>/.gemini/antigravity-cli/settings.json` before each attempt (allow `command(*)`,
   deny `command(git push)` and `command(gh)`); do not edit it.

## The web account

A Worker that runs a step in the operator's signed-in ChatGPT web session
(PROP-0005, [retired](../governance/retired.md); options in the
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
```

The web Runtime declares `web.browse`, so the research Workflow prefers a web account over other capable accounts.

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
Host, `system workers login web/chatgpt/default --remote` prints three steps:
run the `ssh -L ...` line on your own machine (replace the host with the name
you reach the server by if it differs), open the URL in your browser, sign in
and clear any "verify you are human" check yourself (System never clicks it),
then press **Save**. The page and the command print `Signed in` or `Not signed
in: <why>` (exit 0 or 1). **Cancel**, Ctrl-C or 15 minutes end the session
without saving.

`--remote` needs a VNC server on the Host's `PATH`: `x11vnc` (`apt install
x11vnc`) or TigerVNC's `x0vncserver` (`apt install tigervnc-scraping-server`).
Without root, unpack the packages into the home directory and put a wrapper script on the `PATH`.

**Account states.** `system workers` shows any state but `ready` as `unavailable` with what to do (states,
quarantine and recheck: the [web-worker README](../../packages/web-worker/README.md#account-health-ww6d)). After
`needs-sign-in` or `challenged`, log in again with `--remote`, then `system workers recheck web/chatgpt/<name>` and
retry the Work with `work retry`: no prompt is resent automatically.

The attempt's `screenshot` partial output shows the page:
`system work show <id>`, then `system artifact cat <id> > shot.png`.

**The profile** is `$DSH_HOME/system/web/<site>/<name>` (or `profileDir`), a
Chrome user-data directory of mode 0700 that holds the live session: treat it as
a password, keep it out of backups, sync and version control, and delete it to
sign the account out of System.

## The web canary

`tools/web-canary` is the reliability gate of the `web` Workers, read from
System's own records: it stores a fixed Research question (a `task@1`, the same
Artifact ID every time; its answer cites an English Wikipedia page the citation
verifier can read, so it measures the Website Worker and not a third-party site)
and runs `workflows/research.yaml` on it once on each registered `web` Account,
printing one line per Work: Account, Work ID, status, seconds.

```
tools/web-canary                              # run it now
tools/web-canary --task                       # the canary Task's Artifact ID
tools/web-canary --report [--since <ISO>]     # read the records
```

`--report` classifies the finished Works on the canary Task and prints the gate
(`gate: holds` or `does not hold`, exit 3). Run it after each merge into
`web-workers`; the timer does so every six hours.

Install the timer as a user unit like the night session's (below), from
`packages/bundle/system-web-canary.{service,timer}`, with `@NODE@` also
replaced by `$(command -v node)`; it needs the Host running and `system init`
does not install it.

Read it with `systemctl --user list-timers system-web-canary` and
`journalctl --user -u system-web-canary`; start a run with
`systemctl --user start system-web-canary`, stop the series with
`systemctl --user disable --now system-web-canary.timer`. Changing the
question's text starts a new series (a new Task ID).
