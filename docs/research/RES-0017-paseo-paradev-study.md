---
id: RES-0017
type: research
status: active
summary: What System can take from Paseo (getpaseo/paseo, Apache-2.0) and Paradev (paradevai/paradev, MIT), read on 2026-11-26 by eleven subagent studies and one probe of agyhome-1's design; candidates only, none settled.
related: [RES-0015, RES-0016, ADR-0011]
---

# What System can take from Paseo and Paradev

**Research as of 2026-11-26; evidence for a decision, not the decision.** It extends [RES-0015](RES-0015-orca-study.md)
and [RES-0016](RES-0016-orca-study-round-2.md) to two more agent workspaces the operator named. Nothing here is settled;
copied code keeps its licence notice and the commit below.

| Project | Commit | Licence | What it is |
|---|---|---|---|
| [getpaseo/paseo](https://github.com/getpaseo/paseo) | `e4dc119` | Apache-2.0 (Mohamed Boudra) | a daemon, mobile app and encrypted relay driving Claude Code, Codex, Copilot, OpenCode, Pi, Antigravity and Muse |
| [paradevai/paradev](https://github.com/paradevai/paradev) | `09ce262` | MIT (Superset Inc.) | a desktop, web and mobile workspace running many agents in parallel, one worktree each, with cloud sandboxes |

## Sources

Eleven read-only subagent studies (no citation check; file and line references), stored as Artifacts: Paseo agent
lifecycle and providers `sha256:852445fa5bc3dbade7b16794dcd962d3c8f4459cdfb6816a7152625d288f42b9`; Paseo persistence,
protocol and permissions `sha256:8e871a9715df0e38e0369d50c384f829b57e2cab4c9e0547fbba10b89efcd698`; Paseo schedules,
MCP,
CLI and skills `sha256:d1aeb0b621eccd8e98cf45be920f227cba328122f5c1b09a0d08526f52ba97b2`; Paseo process
`sha256:ac6f4ccf2fcf055b8c53d0e386382fa88e02831a13e3a8b73a2c670d7a92b68a`; Paradev agent worker and harness
`sha256:a501dea5eb6c41c34b5dcb67c178f1599216ed90ec044de3b0bf9d9ec1c22e90`; Paradev sandbox
`sha256:1e8db6910a6a449577712aa7b15c86347de679a225482279dab80e1908af6a67`; Paradev MCP, CLI and authority
`sha256:bff1586a20477bd41c210cb0263d16e464396c48f805a8348884c53a6b9a3593`; Paradev review-host and gate
`sha256:c7f32192e2bd782231378392a95d5841130bb4587ea28b8d52412025896e3505`; Paradev host services
`sha256:d7d4e519e7ad1d7ce01acae9991312356f32e7982a708b577cc05443dbce4161`; Paradev process
`sha256:79fcffe11cff3ca6f847efacf110bde72c978c5bc1714d19c5f258937b018385`; Antigravity homes in Paseo and Orca
`sha256:5b81b371ed3f4898f68dc38b8d21845115ada8e933a00b94e52b3c17cb17c698`. The caller session probed agyhome-1's design
on Account a2 (`sha256:ff7fd42768085d04b7b96d8f78b2f3c76a0f874fad0a6d7c42324db79b2037f6`).

## Across the four projects

- **No other project keeps approval human-only.** Orca lets a coordinator allow a worker's request behind a setting;
  Paseo lets any principal with `workspace.write`, and agents through its MCP server, approve permissions; Paradev gives
  agents the user's full authority and calls its agent marker "not a security boundary". System's rule
  ([ADR-0011](../decisions/ADR-0011-human-caller-needs-a-terminal.md)) is its own.
- **None verifies a change against its exact commit before merging.** Paradev merges on a user's click through GitHub
  and stores the head commit only as a cache key; System's Verifier is bound to the Artifact.
- **Isolation is a machine, not a sandbox.** Paradev's cloud boundary is a microVM with an allow-all network; its local
  agents get the user's shell environment. The idea worth keeping is that no credential enters the box: the agent holds
  a placeholder that a proxy swaps for the token.

## Candidates

| Candidate | Source | Note |
|---|---|---|
| agyhome-1's design: a `mktemp` HOME per attempt with `.gemini/antigravity-cli/` holding a link to the Account token and the attempt's settings.json | Paseo, Orca, probe | probe passed (`/usage` read both groups, token unchanged); a token refresh during an attempt is untested |
| An `authority` field per operation in packages/host/src/operations.ts, exhaustive by type; human-only operations refuse non-terminal callers and are not exposed over MCP | Paseo, Paradev | makes ADR-0011 a property of the table |
| `system schema`: the operation table as JSON, with read-only and destructive annotations for MCP | Paradev | one source for CLI, MCP and docs |
| `system work wait` exit codes per outcome (done, failed, timeout, awaiting a human) and `--json` | Paseo | Paseo's own `wait` exits 0 on errors |
| Night-session runs recorded (scheduled, started, status, Works); an unfinished run marked interrupted at the next start | Paseo | missed slots skipped, not caught up |
| `COMPAT(name): added vX, remove after DATE` tags on version shims, with a check for overdue ones | Paseo | the release-boundary defects of PLAN RB |
| Schemas of recorded events never narrow (new fields optional) | Paseo | protects replay of old records |
| Resolve each CLI by probing `--version` over `which -a` candidates; record path and version | Paseo | System gates quota by shape (q-1) but runs the first CLI on PATH |
| A test that `baseEnv` passes no tokens, `SSH_AUTH_SOCK` or `*_API_KEY`; a skip-gated probe of unprivileged bwrap on this kernel | Paradev | first rootless steps of the deferred sandbox |
| A missed-observation rule before `attempt-lost` and an explicit unknown exit | Paradev | check against System's restart path first |
| One rule set: agent-specific files as one-line pointers to AGENTS.md; "write a link, not a paragraph" | Paradev, Paseo | the prose hot spots of RES-0016 |
| A permanent-versus-retryable error list (400, 413, 422, context too long) for Runtime failures | Paradev | feeds the Outside-failure classes |

## Not to take

- Agent approval in any form, auto-allowed permissions (Paradev's Claude harness defaults to `bypassPermissions`),
  keystroke approval of worker prompts.
- In-session "Resume working" nudges and Temporal-style unlimited retries: System re-runs a step from its Artifacts.
- Paseo's JSON stores without migrations and its relay; Paradev's Vercel and Cloudflare services, review-host and gate
  apps (a reviewers' demo machine and a port proxy, not review gates).
