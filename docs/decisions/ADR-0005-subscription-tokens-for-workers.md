---
id: ADR-0005
type: decision
status: accepted
date: 2026-11-05
summary: Workers authenticate with the operator's Claude and ChatGPT subscriptions through System-held tokens instead of provider API keys; this replaces ADR-0004 decision 7.
related: [ADR-0004]
---

# Workers use subscription tokens, not API keys

## Context

[ADR-0004](ADR-0004-mvp-0-operating-decisions.md) decision 7 chose provider
API keys for Worker authentication, because subscription logins live in
mutable files under the operator's home and API keys come with provider usage
reports. The operator has Claude and ChatGPT subscriptions and **no API keys**,
so that decision would block every real Worker run.

Both pinned agent CLIs support subscription authentication without mounting
the operator's home (checked on 2026-11-05 on the development host):

- Claude Code 2.1.311: `claude setup-token` issues a long-lived token; the CLI
  reads it from the `CLAUDE_CODE_OAUTH_TOKEN` environment variable.
- Codex CLI 0.166.0: `codex login --device-auth` writes `auth.json` into the
  directory named by `CODEX_HOME`.

## Decision

1. **Claude Code** Workers get `CLAUDE_CODE_OAUTH_TOKEN` per attempt. The
   token is stored once in the DSH credential store
   (`$DSH_HOME/.credentials.yaml`, mode 0600) with
   `system credentials set CLAUDE_CODE_OAUTH_TOKEN`, which reads it without
   echo. The attempt's `HOME` stays a throwaway directory; `~/.claude` is
   never mounted or copied.
2. **Codex** Workers authenticate from a System-owned `CODEX_HOME`,
   `$DSH_HOME/system/codex/<account>`, populated once by the operator with
   `codex login --device-auth`. It is never the operator's `~/.codex`.
3. **One Worker per account.** Each configured account is its own Worker
   registration with its own `ref` (such as `claude-code/default`) and its own
   credential: a `tokenRef` naming a credential-store entry for Claude Code,
   a `CODEX_HOME` directory for Codex. Adding an account is a configuration
   change, not a code change. MVP-0 configures one `default` account per CLI,
   using the ref `CLAUDE_CODE_OAUTH_TOKEN`; routing stays by capability, and
   choosing among accounts by quota or rotation is deferred past MVP-0.
4. Whether each attempt shares that directory or gets a copy of its
   `auth.json` is decided in M3 by test, because Codex refreshes and rewrites
   `auth.json`, and a shared directory also accumulates session history that
   a later attempt must not read (ADR-0003 decision 1). The result is
   recorded in the adapter README and this ADR's follow-up section.
5. Each attempt records the account, the agent CLI's absolute path and its version.
6. ADR-0004 decision 7 no longer applies; every other ADR-0004 decision holds.

## Consequences

- Worker runs draw on the same subscription limits as the operator's own use.
- Usage is observed from the agent CLIs' own JSON output where they report it
  (verified in M3); there is no provider billing report to compare against,
  so the MVP-1 usage-oracle comparison will be marked unverified unless
  another oracle is found.
- The tokens are files readable by the operator's OS user. MVP-0 has no
  sandbox (ADR-0004 decision 14), so a misbehaving agent could read them;
  this is the existing MVP-0 limitation, not a new boundary.
- Tests that need real Workers are opt-in and skipped without these tokens.

## Alternatives considered

- **Provider API keys** (ADR-0004 decision 7): not available to the operator.
- **Mount or copy `~/.claude` and `~/.codex` into each attempt:** rejected;
  it exposes the operator's whole agent configuration and history.

## Follow-up: decision 4, settled by test (2026-11-06)

A probe of Codex CLI 0.166.0 with `--ephemeral` and a shared `CODEX_HOME`
found `memories_1.sqlite`, `state_5.sqlite`, shell snapshots and logs written
there, so a shared directory carries state between attempts. A second probe
with a fresh `CODEX_HOME` holding only a copy of `auth.json` ran normally.
Each attempt therefore gets a fresh `CODEX_HOME` with only `auth.json`; a
refreshed `auth.json` is copied back to the account directory unless that file
changed meanwhile, and attempts of one account run one at a time. See
[`@system/agents`](../../packages/agents/README.md).
