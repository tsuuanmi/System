---
id: ADR-0011
type: decision
status: accepted
date: 2026-11-14
summary: A CLI call is a human only at a terminal (SYSTEM_CALLER=human no longer lifts a pipe to human), and retrying a verify step asks the same typed confirmation as `system approve`; the human/agent boundary within one OS user stays advisory until Workers run as another user.
supersedes: [ADR-0004]
---

# A human caller needs a terminal

## Context

[ADR-0004](ADR-0004-mvp-0-operating-decisions.md) decision 3 lets
`SYSTEM_CALLER=human` label a call whatever stdin is. Every Worker and agent
session runs as the operator's OS user, so an agent can set it, or run any
command the operator can. The boundary between processes of one user is
**advisory**: it prevents mistakes, not a determined agent.

## Decision

1. **Threat model.** Within one OS user the human/agent boundary is advisory.
   Running Workers as another OS user waits for the sandbox milestone and
   must come before unattended dispatch grows.
2. **A terminal makes a human.** `caller()` returns `human` only when stdin
   is a terminal; `SYSTEM_CALLER=agent` may lower that, nothing raises it.
   MCP still declares `agent`. This replaces the `SYSTEM_CALLER=human` part
   of ADR-0004 decision 3; the rest of it stands.
3. **Verifying again is typed.** `system work retry --step <step>` for a
   verify step asks the typed terminal confirmation of `system approve`
   (the Host's controller already refuses a non-human verify-again).

## Consequences

Scripts and tests that need a human run on a pseudo-terminal
(`systemCli().run(..., { terminal: true })`).
