# @system/agents

The `agents` row: each configured agent CLI account (and, as a third Runtime,
the operator's ChatGPT website session) becomes a System Worker
([ADR-0004](../../docs/decisions/ADR-0004-mvp-0-operating-decisions.md) decisions 4-6,
[ADR-0005](../../docs/decisions/ADR-0005-subscription-tokens-for-workers.md)).

- **Injects:** `capabilities`, `artifacts`, `subprocess` (DSH), `credentials` (DSH).
  **Provides:** `ctx.agents` (`system workers`).
- **Accounts:** one config entry per account; an account whose CLI or
  credential is missing is skipped with its reason. Routing takes the first
  capable registered account; `system work retry --worker <ref>` names one.

```yaml
- id: agents
  config:
    attemptTimeoutMinutes: 60           # row-wide default; an account may set its own
    maxConcurrentAttempts: 1            # row-wide default (1); an account may set its own
    accounts:
      - ref: claude-code/default        # <runtime>/<account>
        runtime: claude-code
        capabilities: [code-write, research, web-search]
        tokenRef: CLAUDE_CODE_OAUTH_TOKEN  # system credentials set <name>
        models: {economy: haiku, standard: sonnet, frontier: opus}  # adds tier.* capabilities
        maxConcurrentAttempts: 2        # attempts of this account at once; default 1
      - ref: codex/default
        runtime: codex
        capabilities: [code-write]
        codexHome: codex/default        # under $DSH_HOME/system unless absolute
      # A second account is another entry with its own ref and credential.
```

## Model tiers

Tiers are those of System 1: `economy`, `standard`, `frontier`. An account's
`models` maps each tier it offers to a model; each listed tier adds the
capability `tier.<name>`, so a Workflow step asks for one like any other
capability (`capabilities: [code-write, tier.frontier]`) and preflight refuses
a tier no enabled account offers. A step with no tier gets the `standard`
model, or the CLI's default when the account lists none. Each attempt records
the tier, the configured model, and the models the CLI reports it served.

```yaml
      - ref: claude-code/default
        runtime: claude-code
        models: {economy: haiku, standard: sonnet, frontier: opus}
```

Verified on 2026-11-06 with Claude Code 2.1.311: `haiku`, `sonnet` and `opus`
served `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5`. Codex's
tiers come from the models Codex 0.166.0 lists for this account, by their own
descriptions: `gpt-6-luna` (economy), `gpt-6.1-sol` (standard), `gpt-6-astra`
(frontier). Codex does not report which model served, so only the requested
model is recorded for it.

## One attempt

1. **Workspace** under `$DSH_HOME/system/attempts/<attempt>`: `home/` (the
   agent's throwaway `HOME`), `in/` (inputs that are bytes or JSON; a task's
   `context` under `in/context/`, a conversation as its manifest and parts,
   listed in the prompt as operator-supplied data, not instructions), `out/`
   (output files), `work/`. `work/` is a detached `git worktree` of the exact
   commit an input names (`previous` first, then a `git-tree@1` input or a
   task's `base`), or an empty directory.
2. **Environment:** every host variable is removed except `PATH`, `LANG`,
   `LC_ALL` and `TZ`. The agent gets `HOME`, `TMPDIR` and its account's
   credential only: `CLAUDE_CODE_OAUTH_TOKEN`, or a fresh `CODEX_HOME` holding
   a copy of the account's `auth.json`.
3. **Run** through the DSH subprocess service, which owns the process range in
   a user-systemd scope:
   - `claude -p <prompt> --output-format stream-json --verbose [--model <tier's model>] --permission-mode acceptEdits
     --allowedTools Bash WebSearch WebFetch --disallowedTools "Bash(git push:*)" "Bash(gh:*)"`
   - `codex exec --json --ephemeral --ignore-user-config --skip-git-repo-check [-m <model>]
     -s workspace-write -C work --add-dir out <prompt>`
4. **Capture**, the same rule for every domain: in a git workspace the first
   output slot is the working tree, committed on the base with a private index
   as `git-tree@1` and pinned at `refs/system/artifacts/<commit>`; every other
   slot is the file `out/<slot>` as `file@1`. A missing output fails the attempt.
5. **Record:** usage from the CLI's own output (unknown when absent), summed
   over every turn: a background command's completion notification starts a
   second turn, and Claude Code's `stream-json` prints a `result` for each,
   where its `json` format prints only the last. Claude Code's tokens come
   from each result's `modelUsage`, summed over its models, because that counts
   subagents while `usage` does not; `usage` is the fallback only when a result
   has no `modelUsage`, and `source` says which was used. Fields: the total
   `inputTokens` plus `cacheReadTokens` and `cacheWriteTokens` when the CLI
   splits them (Codex reports no cache writes, so it has no write field), so
   fresh input is the total minus both; and, for Claude Code only, `costUsd`,
   the CLI's client-side API-equivalent estimate (`costUSD` per model, or
   `total_cost_usd`), not what the subscription is billed, present only when
   every result reports one. The last result decides success and the message;
   lines that are not results are ignored. Then the account, CLI path and
   version (asked once, on first use, never at startup), and the stdout's last
   256 KiB as a `local-private` log Artifact. The log is never handed to
   another Worker, and is only a bounded copy: usage is parsed from the whole
   stdout (kept to its last 64 MiB), never from the log.
6. **Clean up:** the worktree registration and the attempt directory are removed.

**Cancel:** the controller aborts the attempt; DSH sends SIGTERM to the range
and SIGKILL after 30 s. Whatever the attempt left is captured as unaccepted
partial output; `system work retry` hands it to the next attempt as `previous`.

**Codex auth** (ADR-0005 decision 4, decided by test on 2026-11-06): even
with `--ephemeral`, Codex 0.166.0 writes `memories_1.sqlite`, `state_5.sqlite`,
shell snapshots and logs into `CODEX_HOME`, so a shared directory would carry
state between attempts. Each attempt therefore gets a fresh `CODEX_HOME` with
only `auth.json`; a refreshed `auth.json` is copied back to the account
directory unless that file changed meanwhile. The Host's slots decide how many
attempts of an account run at once (`maxConcurrentAttempts`, default 1); the
worker queues nothing itself. Raise the limit for a Codex account only if its
`auth.json` refresh can tolerate it: the copy-back keeps the first refresh and
drops a later one when the file changed meanwhile.

**Lost attempts:** each attempt's CLI is started by a shell that first writes its
process ID to `$DSH_HOME/system/attempts/<attempt>.pid` (`exec` keeps it) and
the worker removes the file when the CLI ends. After a Host is killed, the file
is what `gone(attemptId)` reads: no file, or a pid that no longer exists, means
the process is gone and the attempt's slot may be freed (`Host.settle`); a live
pid keeps it held.

## Verified on this host (2026-11-06)

Linux 5.4 (no Landlock), Claude Code 2.1.311 with a `setup-token` token,
Codex CLI 0.166.0 with a device-auth login: both run headless with a throwaway
`HOME`; Codex's `workspace-write` sandbox works; both report token usage.

## The `chatgpt-web` Runtime

An Account `chatgpt-web/<name>` runs one step as one prompt in the operator's
own signed-in ChatGPT web session ([PROP-0005](../../docs/proposals/PROP-0005-chatgpt-website-worker.md)).
It is in [chatgpt.ts](src/chatgpt.ts) (the sign-in is in [chatgpt-login.ts](src/chatgpt-login.ts)), drives a genuine headed Chrome with
`patchright-core` 1.63.0 (System 1's pin; [chrome.ts](src/chrome.ts) chooses the Chrome and installs the pinned Chrome for Testing on first use), and runs inside the Host,
not as a spawned process. It is not in the bundle's `agents` row; add it as in
the [runbook](../../docs/operations/runbook.md#the-chatgpt-web-account).

```yaml
      - ref: chatgpt-web/default
        runtime: chatgpt-web
        capabilities: [research, web-search]   # brainstorm.idea-<role> too, by role
        # all optional, with these defaults:
        profileDir: chatgpt-web/default        # under $DSH_HOME/system unless absolute; mode 0700
        temporaryChat: true                    # each attempt in a temporary chat
        url: https://chatgpt.com/
        executablePath: ...                    # default: CHROME_PATH, a recent system Chrome, else the managed Chrome for Testing
        timeouts: {load: 60, answer: 900, stable: 3}   # seconds
```

One attempt:

1. **Launch** a persistent Chrome context on `profileDir`, **headed**: the
   profile is the Account's credential and is reused by every attempt. One
   attempt at a time per Account (Chrome locks the profile). The browser is
   never headless: it runs on the Host's `DISPLAY`, or when there is none on a
   private Xvfb ([display.ts](src/display.ts)) that the attempt starts and stops,
   also on cancel and on the time limit. Without Xvfb on `PATH` the Account is
   `unavailable`, with a reason naming it, and an account that sets `headless` is
   too.
2. **Open and send** with System 1's ChatGPT web driver, ported whole into
   [`@system/web-driver`](../web-driver/README.md): `open` loads the site's home
   and reads the page's state (`checkAuth`: up to `load` seconds; a visible
   composer is signed in; a challenge, the login page, the logged-out home held
   3 s and the site's own error page are each their own failure), selects
   **Chat** (a composer that names Work is refused: Work spends the Codex
   quota) and, when `temporaryChat`, **Temporary chat** by the page's own
   control. System never types into or solves a challenge. The driver then
   clears the composer, reads the model back and sends one prompt built like the
   CLI prompt, with the inputs (and context) inlined as text, and each output
   slot asked for as a fenced block labelled with its name. At most 200 KiB.
   Nothing in the Runtime knows a selector: the UI map is the driver's.
3. **Wait** as the driver does: the answer's finished marker and text unchanged
   for `stable` seconds, within `answer` seconds (a stall clock of 3 minutes, or
   half of `answer` when that is shorter).
4. **Read** the answer as Markdown from the page's own Copy control (kept only
   when its words are the rendered answer's; the rendered text otherwise),
   followed by the cited links the text lacks. Its links are the URLs in it.
5. **Drift and heal:** what the driver reports (a drifted element, a refused
   Copy, a stall) goes to the attempt's log as counts and structure only.
   Self-heal is off: no decision store exists.
6. **Fill** each slot from its labelled block (a longer fence holds shorter
   ones; the first block of a name wins). A missing block fails the attempt;
   what was found stays as unaccepted partial output.
7. **Record** a `conversation@1`: `prompt.md` and `response.md` as parts,
   `links.json` (the cited hrefs) as an attachment, asserted `provider:
   ChatGPT`, the page `url`, the `model` the driver read back from the model
   menu and `context: [ui-map:<uiRevision>, temporary-chat]` (the latter when
   used). Its
   producer is the Worker (the attempt observed the exchange). It is returned as
   the extra output `conversation` (the controller records only a step's
   declared slots). Usage is unknown. The log is the stage notes.

On any failure the page's screenshot is kept as partial output `screenshot`.
Cancel and `attemptTimeoutMinutes` close the browser, as they stop a CLI. A UI
change is a change to the driver's map (`packages/web-driver/ui/chatgpt-web.ui.yaml`),
not to this Runtime. After a lost attempt the Account's slot is held while the
process in Chrome's `SingletonLock` lives.

**Login** (`system workers login chatgpt-web/<name> [--cookies <file> | --remote]`,
operator-only operations `workers.login`, `workers.loginRemote` and
`workers.loginWait`): `--cookies` imports a JSON (browser-extension export) or
Netscape cookie file, keeping only chatgpt.com and openai.com cookies and giving
a session cookie a 30-day lifetime, and deletes nothing; the file is read once by
the CLI. With neither flag, a visible window opens on the Host's `DISPLAY` and
waits up to ten minutes for a sign-in. Each uses the same headed browser as an
attempt, so a check cleared in one stays valid for attempts that share the
profile. The signed-in state is then checked and reported; no cookie value is
printed.

`--remote` ([remote-login.ts](src/remote-login.ts)) is for a Host with no display
and for a Cloudflare challenge that only a human can pass. It is a port of System 1's
remote login (the file's header names the source and its commit). It opens the
profile headed on a private Xvfb (over the engine's pipe: no CDP port) with a VNC
server on that Xvfb (`x0vncserver` or `x11vnc`, first found on `PATH`; without
one it fails at once, naming both) reachable only through an owner-only unix
socket, and serves noVNC (`@novnc/novnc` 1.7.0, MPL-2.0, served unmodified;
`ws` 8.22.0 bridges its WebSocket to the socket) on `127.0.0.1` on a random port
under a random 32-byte token (404 without it, and for a Host header other than
loopback). The page shows the whole Xvfb screen, scaled to the window
(`scaleViewport`), with real X input, **Save** and **Cancel** (a POST only from
the page's own origin). `x11vnc` is run per connection with `-inetd` behind a
socket the Host listens on, because 0.9.16 has no unix-socket-only mode and
would open TCP port 5900. The CLI prints the `ssh -L <port>:127.0.0.1:<port> <user>@<host>`
line and the URL; the runbook has the steps. Save closes the browser cleanly (so
`cf_clearance` and the session stay in the profile), checks the signed-in state
(the driver's `checkAuth`) and reports it; Cancel, Ctrl-C or the 15-minute TTL end the session without a
check. Everything it started (Xvfb, VNC server, browser, server) is stopped. Nothing
solves or clicks a challenge.

## Limits

The `chatgpt-web` Runtime is outside OpenAI's Terms of Use for its web product; the operator accepted that for their own account (PROP-0005). It needs a Chrome new enough for chatgpt.com: the pinned build is installed under `$DSH_HOME/system/browsers` when no recent one exists.

No sandbox or egress control (ADR-0004 decision 14): the agent runs as the
operator and could read the operator's files, including the credential store.
No retries, and no time limit beyond the attempt's. `--allowedTools Bash` lets Claude Code
run any shell command except `git push` and `gh`.

## Reuse

The git capture technique follows System 1's worktree recorder; see
[`@system/work`'s git.ts](../work/src/git.ts).
