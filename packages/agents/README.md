# @system/agents

The `agents` row: each configured agent CLI account (and a `web` account, through
the optional web-worker row) becomes a System Worker
([ADR-0004](../../docs/decisions/ADR-0004-mvp-0-operating-decisions.md) decisions 4-6,
[ADR-0005](../../docs/decisions/ADR-0005-subscription-tokens-for-workers.md)).

- **Injects:** `capabilities`, `artifacts`, `subprocess` (DSH), `credentials` (DSH). Reads
  `webWorker` if the web-worker row provides it.
  **Provides:** `ctx.agents` (`system workers`; `quota(ref)`).
- **Accounts:** one config entry per account; an account whose CLI or
  credential is missing is skipped with its reason. Routing is by headroom (see
  Routing by headroom); `system work retry --worker <ref>` names one.
  An account may set `label` (free text for people, e.g. an email) and
  `priority: primary` (omitted is secondary). At most one account per Runtime
  may be primary: a later one is not registered and says so. Refs are stable
  handles that are never reused (`claude-code/c1`, `codex/x1`); existing refs
  such as `claude-code/default` stay valid.

```yaml
- id: agents
  config:
    attemptTimeoutMinutes: 60           # row-wide default; an account may set its own
    maxConcurrentAttempts: 1            # row-wide default (1); an account may set its own
    attemptBudget: {inputTokens: 30000000, minutes: 45}  # row-wide default (none); an account may set its own
    quotaCeilingPercent: 80             # 1-100; a window at or above this share used is over (see Routing by headroom)
    accounts:
      - ref: claude-code/default        # <runtime>/<account>
        runtime: claude-code
        label: me@example.com           # free text for people
        priority: primary               # at most one per Runtime; omitted = secondary
        claudeHome: claude/default      # holds .claude.json (provider account ID); under $DSH_HOME/system unless absolute; this is the default (claude/<name>)
        capabilities: [code-write, code.develop, research, web-search]
        tokenRef: CLAUDE_CODE_OAUTH_TOKEN  # system credentials set <name>
        models: {economy: haiku, standard: sonnet, frontier: opus}  # adds tier.* capabilities
        maxConcurrentAttempts: 2        # attempts of this account at once; default 1 (a web account: always 1)
      - ref: codex/default
        runtime: codex
        capabilities: [code-write, code.tests]
        codexHome: codex/default        # under $DSH_HOME/system unless absolute
      # A second account is another entry with its own ref and credential.
```

## Account identity

At registration the row reads the provider's own account ID, without a model
turn, from files of the account (never the real `~/.claude`): Claude Code from
`<claudeHome>/.claude.json` `oauthAccount.accountUuid`, else `emailAddress`;
Codex from `tokens.account_id` of `<codexHome>/auth.json`; a `web` account has
none. It is recorded as `providerAccount` and shown by `system workers` and
`workers.list` with `label` and `priority`; only that field is read, never a
token. When two accounts of a Runtime resolve to the same ID, the later one in
profile order is not registered, with the reason `provider account <id> is
already registered as <first ref>; two refs on one account would count its
quota twice`. An ID that cannot be read leaves the account registered with
`providerAccount` unknown. The operator puts the `.claude.json` of a Claude
account in its `claudeHome`. Registering a Claude Code account creates a missing
`claudeHome` (mode 700), as the row owns it; if it cannot be created the account
stays registered and its quota reason names the directory. A `codexHome` is not
created: Codex needs a signed-in home.

## Quota

`quota(ref)` says how much of an account's 5-hour and weekly window is used and
when each resets, without a model turn. It spawns only when asked, never at
registration or in `accounts()`.

- **Claude Code:** `claude -p --input-format stream-json --output-format stream-json
  --verbose --no-session-persistence --strict-mcp-config` with no prompt and no model,
  started with only `HOME` (the account's `claudeHome`), `TMPDIR`, the account's
  `CLAUDE_CODE_OAUTH_TOKEN`, `PATH`, `LANG`, `LC_ALL` and `TZ`. One stdin line, the
  control request `get_usage` (`skip_behaviors: true`); the `control_response` with that
  `request_id` is the answer. Then stdin is closed and the process group ended.
- **Codex:** `codex app-server` with the account's `CODEX_HOME`: `initialize` (with
  `capabilities: null`), `initialized`, `account/rateLimits/read`. Windows are named by
  length (300 minutes is `five_hour`, 10080 is `seven_day`), never by `primary`/`secondary`.
  The app server may refresh `auth.json` in that `CODEX_HOME`; attempts copy a fresh
  `CODEX_HOME`, so a refresh by the reader can race the copy-back's digest check
  (not changed here).
- **Output:** `{ observedAt, windows: { five_hour?, seven_day? } }`, each window
  `{ percentUsed (0-100), resetsAt? }`, or `{ unreadable: <reason> }`. An answer is readable
  or unreadable as a whole: one malformed entry (a share below 0 or above 100, a window that
  is not an object, a reset in the wrong unit or not a time) makes it unreadable. Only
  `five_hour` and `seven_day` are read: Claude Code's other entries are ignored unvalidated,
  and a Codex window of another length is validated, then ignored. A `web` or unknown ref
  is unreadable.
- **Reset rule:** a reset is dropped (keeping `percentUsed`) only when it is already past
  while the share is 100%, or more than 400 days from the reading (System 1's `PLAUSIBLE_MS`).
  A future reset at 100% is kept.
- **Version gate:** only Claude Code 2.1.322 and Codex 0.166.0 are read; `--version` is
  asked first and nothing else is spawned for another version, which is `unreadable`
  and names it. Checked on 2026-11-10 from the installed binaries and
  `codex app-server generate-ts`, **not on a live account**: Claude's `get_usage` and
  `control_response` envelopes, its `{ utilization, resets_at }` windows, and the
  `rate_limit_event` fields; Codex's `RateLimitWindow`, `GetAccountRateLimitsResponse` and
  the nullable `InitializeParams.capabilities`. Not checked: that a live account answers,
  and that 2.1.322 starts with no user message (a release check for the operator).
- **Cache:** each reading, readable or `unreadable`, is kept 10 minutes (`quota.ttlMs` in
  the row's config is a test hook); simultaneous asks share one read. The cache does not
  check for an aborted read, and the row passes no abort signal, so an aborted read is kept
  too. Claude Code's `rate_limit_event` in an attempt's output (`utilization` is a fraction,
  `resetsAt` Unix seconds; a share outside 0 to 1 is ignored, not clamped; `status: rejected`
  with no utilization is 100%) replaces that window in the cached reading and sets
  `observedAt`, without extending the expiry. With no reading cached, the event makes a
  reading of that one window, which expires 10 minutes later.
- **Source:** System 1, `/home/tan/workspaces/system-agents` commit `15e2bd5`:
  `packages/plugins/runtime-claude-agent-sdk/src/limits.ts` and
  `packages/plugins/runtime-codex-sdk/src/rate-limits.ts`; not its ledger, pools,
  reservations or per-model windows. Code: [quota.ts](src/quota.ts). The reading is
  returned here; routing records the readings it used (below).

`system workers` and the MCP tool `workers.list` show each account's last reading, read
through `quota(ref)` and its cache (never a model turn, never a token): under the account's
line, `quota: 5h 18% (resets 23:03), 7d 10%, read 2 min ago`, or `quota: unreadable - <reason>`.
The reasons: `a web account has no quota reader`; `the usage report of <label> <v> is not
verified (verified: …)` (the CLI version is not one checked); `its token is not configured`;
`its claudeHome <path> does not exist and could not be created` (the home is missing at
read time, so the CLI is never spawned; the row creates it at registration, see Account
identity); `not registered: <why>` or `still registering` for an account that is not up. `accounts()` itself never spawns; the Host's `workers` view
asks `quota(ref)` for each account.

## Routing by headroom

Among the accounts that have every capability of a step and a free slot (the rule is
`rankByHeadroom` in [headroom.ts](../work/src/headroom.ts); the controller reads `quota()` of
each, once per choice):

1. The `priority: primary` account takes the step while both its windows are under the ceiling.
2. Otherwise the free account with the most headroom (100 minus its fuller window; ties by
   registration order). An account at or over the ceiling in either window is not chosen.
3. An account whose quota is `unreadable`, and every `web` account, ranks after all readable
   accounts under the ceiling, in registration order, but stays usable.
4. All over the ceiling and none unreadable: the step does not start and spends no attempt. It
   shows `waiting: quota` with the earliest reset, and is tried again when a slot frees, at
   that reset, or every 5 minutes, whichever comes first.
5. An attempt that fails because its account is out of quota or credits (sc-14) is recorded as
   `limited`, not failed. The account's reading is read again at once (`quota(ref, { fresh })`
   drops the cache) and the account is passed over for that step for 5 minutes. The step is
   routed again: another account under the ceiling takes it, or with none it waits as in rule 4.
   It spends no attempt or retry.

The ceiling is `quotaCeilingPercent` on the `agents` row (1 to 100, default 80; another value
refuses every account). The `dispatched` event records each candidate's reason
(`primary under 80% (5h 43%, 7d 31%)`, `headroom 57% (...)`, `over 80% (5h 91%)`,
`quota unreadable: ...`), so replay reads the record and never asks a provider. The 10-minute
cache means a reset is seen at the next reading after it.

## Software Engineering policy and the attempt budget

`code.develop` is a role: the plan, implement and docs steps of the code Workflows ask for it (see the [Workflows README](../../workflows/README.md)), so the Claude Code account above takes them. `code-write` is the permission to write the checkout, not a role; in the example, Codex has `code-write` and `code.tests`, so it takes only the `tests` step.

A `code-write` attempt runs every command in the foreground (PROP-0007
decision 1): Claude Code gets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` and
`Monitor` among its disallowed tools, and every Runtime's prompt says to run
each command under `timeout` and wait for it. When the repository has `.system/checks.yaml` at the base commit, the prompt also tells it to run the checks whose `paths` match its changed files before it finishes. A wait on a background job
re-reads the whole context at each wake: 183M input tokens in one attempt.

`attemptBudget` (decision 2) stops an attempt through the same abort as a
cancel, and fails it with `over budget: input tokens (<n> of <limit>)` or
`over budget: <m> minutes`; its partial output is kept. Input tokens count
cache reads, from the progress read off the stream (`inputTokens`), checked
each time the stream grows. `attemptTimeoutMinutes` stays the hard limit.

## Model tiers

Tiers are those of System 1: `economy`, `standard`, `frontier`. An account's
`models` maps each tier it offers to a model; each listed tier adds the
capability `tier.<name>`, so a Workflow step asks for one like any other
capability (`capabilities: [code-write, tier.frontier]`) and preflight refuses
a tier no enabled account offers. A `web` account offers the three tiers when its Site map binds a Power control and it runs the generic Procedures (the `web-worker` row reports them; see its [README](../web-worker/README.md)). A step with no tier gets the `standard`
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
   commit an input names (`base` first, then `previous`, then a `git-tree@1` input or a
   task's `base`; a git-tree input that is not the starting point is listed in the
   prompt as a commit of the same repository, to show or cherry-pick), or an empty
   directory.
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
   While it runs, its stdout is read every 0.5 s; when it grew, the attempt
   reports its progress (`progressReader`: turns, the last tool, tokens so
   far) to the Host, which keeps it in memory only.
4. **Capture**, the same rule for every domain: for a step with `code-write`
   in a git workspace the first output slot is the working tree, committed on
   the base with a private index as `git-tree@1` and pinned at
   `refs/system/artifacts/<commit>`; every other slot, and every slot of a step
   without `code-write`, is the file `out/<slot>` as `file@1`. A change such a
   step makes to the checkout is not an output. A missing output fails the attempt.
   A change equal to its base (the tree is the base commit's own) is still
   captured, and the Worker reports its final message beside the outputs; the
   controller then fails the step with "no change: the working tree is the same
   as the base commit <short sha>" and that message, shortened, but only when a
   later verify or effect step takes that output as its subject. Read-only
   steps (the scouts of `hygiene.yaml`) name a `checkout` nothing verifies or
   publishes, so an unchanged one stays a success, as does a step declared
   `mayBeEmpty` (the docs step of `feature.yaml`). The exception is a step with
   `retry.rerunUnchanged` that a failing check reopened (sc-9): the check runs
   again on the same change instead.
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

**Exit ends the attempt (WW1c):** the attempt ends when the agent process exits,
never when its pipes close. Its output is then drained and its process range given
`DRAIN_MS` (5 s) to empty; after that the pipes are closed and what is left is
terminated. On 2026-11-07 two Xvfb leaked by a Worker's own tests held a finished
attempt "running" for 33 min, because the Runtime waited for the whole range and its
output to end. [agent.test.ts](tests/agent.test.ts) tests it with a fake agent that
leaves a child holding stdout open.

**Codex auth** (ADR-0005 decision 4, decided by test on 2026-11-06): even
with `--ephemeral`, Codex 0.166.0 writes `memories_1.sqlite`, `state_5.sqlite`,
shell snapshots and logs into `CODEX_HOME`, so a shared directory would carry
state between attempts. Each attempt therefore gets a fresh `CODEX_HOME` with
only `auth.json`; a refreshed `auth.json` is copied back to the account
directory unless that file changed meanwhile. The Host's slots decide how many
attempts of an account run at once (`maxConcurrentAttempts`, default 1; always 1 for a web account, one Chrome profile); the
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
`HOME`; Codex's `workspace-write` sandbox works; both report token usage. The quota shapes were checked on 2026-11-10 from the installed binary and `generate-ts`, not on a live account (see Quota).

## The `web` Runtime

An account with `runtime: web` is not run here: the optional [`web-worker` row](../web-worker/README.md)
serves it, and `agents` only hands it over through the `webWorker` service ([web.ts](src/web.ts):
the contract, and `WEB_WORKER_DISABLED`). With that row off the account is reported
`unavailable` with the reason "the web-worker row is disabled". It keeps the `agents` row's settings
(`models` tiers, `attemptTimeoutMinutes`, `maxConcurrentAttempts`) and its entry in `accounts`.

## Limits

No sandbox or egress control (ADR-0004 decision 14): the agent runs as the
operator and could read the operator's files, including the credential store.
No retries, and no time limit beyond the attempt's. `--allowedTools Bash` lets Claude Code
run any shell command except `git push` and `gh`.

## Reuse

The git capture technique follows System 1's worktree recorder; see
[`@system/work`'s git.ts](../work/src/git.ts).
