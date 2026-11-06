# @system/agents

The `agents` row: each configured agent CLI account becomes a System Worker
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

## Limits

No sandbox or egress control (ADR-0004 decision 14): the agent runs as the
operator and could read the operator's files, including the credential store.
No retries, and no time limit beyond the attempt's. `--allowedTools Bash` lets Claude Code
run any shell command except `git push` and `gh`.

## Reuse

The git capture technique follows System 1's worktree recorder; see
[`@system/work`'s git.ts](../work/src/git.ts).
