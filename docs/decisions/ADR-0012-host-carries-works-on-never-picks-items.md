---
id: ADR-0012
type: decision
status: accepted
date: 2026-11-14
summary: The Host carries admitted Works on and never picks an Item or creates a Work; picking, writing the Task and submitting is a caller's act (scheduled sessions included); Items stay in each repository's STATUS.md with derived state, and a database is reconsidered only on three stated triggers.
---

# The Host carries Works on and never picks an Item

## Context

Milestone CM ([PLAN 3d](../../PLAN.md)) makes work continue across a
restart and across Items. [ADR-0009](ADR-0009-goals-and-orchestrators.md) is
superseded: System has no Goal engine, planner or dispatcher of its own.
Evidence: research Work `work:dcf503df-fd54-5cb8-b079-c098beae7c6e` (R1) and
synthesis `work:d9c19b94-ed21-5eb0-84ab-506dc2c8e9aa`.

## Decision

1. **The Host carries on, never picks.** After a restart the Host resumes
   admitted Works, including those that were only waiting (cm-1, cm-9). It
   never picks an Item and never creates a Work.
2. **Picking is a caller's act.** Choosing the next Item, writing its Task
   and submitting it belongs to a caller: an operator's session, an agent
   session, or a session started on a schedule (the night session).
3. **Items stay in STATUS.md.** Each repository's `STATUS.md` holds its
   Items, written through reviewed changes. Their state (todo, doing, done,
   Ready, Blocked) is derived from STATUS.md and the Host's records, never
   stored. Claims and Works are the Host's records.
4. **When to reconsider a database for Items:** only if dependencies must
   cross repositories, or STATUS.md passes about 100 lines in two projects,
   or merge conflicts on STATUS.md exceed one a week.

## Alternatives rejected

- **A resident dispatcher or planner in the Host:** a second brain, model
  cost while waiting, and it duplicates what caller sessions already do.
- **STATUS.json or a database:** no gain in determinism (state is already
  derived and claims are already atomic in the Host), loses review in pull
  requests, and makes two homes for intent.

## Consequences

Unattended progress needs a scheduled caller session, not a Host feature.
