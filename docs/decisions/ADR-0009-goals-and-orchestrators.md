---
id: ADR-0009
type: decision
status: accepted
date: 2026-11-07
summary: A Goal is an immutable operator-written Artifact (aim, scope, budget, principles as context) whose spend is folded from its Works, and an Orchestrator is an agent caller reaching the Host through `system mcp`, scoped to one Goal, that may never approve, accept or merge; the Host notifies it when its Works change state.
related: [ADR-0002, ADR-0003, ADR-0004, ADR-0007, ADR-0008]
---

# Goals and Orchestrators

## Context

The operator has been directing System through an agent session that submits
Works, waits for them, reviews the results and decides the next step. That
is the Orchestrator role. The decisions of 2026-11-06 (milestone O in
[PLAN.md](../../PLAN.md)) moved it into System:

- a **Goal** gives an Orchestrator its aim, its scope and its budget;
- the Orchestrator reaches the Host through MCP;
- it gets an agent's authority, never more;
- it is told when its Works change state, instead of polling.

The terms are in [GLOSSARY.md](../../GLOSSARY.md).

## Decision

1. **A Goal is an Artifact.** It is `goal@1`, written by the operator, with
   this content:
   - `aim`: what to achieve;
   - `scope`: what is in and out;
   - `budget`: `attempts` and `tokens`. Tokens count fresh input (cache writes included) plus output.
     Cache reads are left out, because they are not comparable across
     Runtimes;
   - `context`: Artifact IDs every Work of the Goal receives as Task context.
     The Charter's principles are there by default.

   It is immutable. A raise or a change is a new `goal@1` that supersedes the
   old one through `lineage`. Only a human at a terminal creates or
   supersedes a Goal.
2. **Spend is folded, not stored.**
   - A Work admitted for a Goal records the Goal's ID in its `admitted` event.
   - The Goal's spend is the sum of the attempts and the observed usage of its
     Works.
   - Admission refuses a new Work once the spend has reached the current
     budget. Running Works finish.
   - No mutable budget table exists, and replay reproduces the spend exactly.
   - Attempts whose usage is unknown count as attempts, and as zero tokens,
     shown as unknown.
3. **`system mcp`.** It is a stdio MCP server, started by the agent's client
   (for example Claude Code), that connects to the Host as a client.
   - It offers as MCP tools exactly the operations the Host's table flags
     `agent: true`.
   - It identifies its caller as `{ type: "orchestrator", operatorId, goal }`
     when started with `--goal <id>`, and as `agent` otherwise.
4. **Scope.** An orchestrator caller may submit Works only for its Goal. It may
   run, retry and cancel only that Goal's Works, and it reads only that
   Goal's Works and their Artifacts. Everything flagged `agent: false` stays
   refused: approve, deny, storing a conversation, and credentials. Merging
   into `main` stays the operator's (ADR-0008).
5. **Completion notices.**
   - The MCP server exposes each of the Goal's Works as a resource,
     `system://work/<id>`, which the client may subscribe to.
   - When a Work becomes terminal or held, or waits for approval, the Host
     tells the adapter, which sends `notifications/resources/updated`.
   - A notice only wakes the client. It reads the change with `work.events`
     from its cursor, so a missed notice loses nothing.

## Implemented

- Decisions 1 and 2 (O1), as fixed by the spec review (F2):
  - A Goal's Work needs an input Task to carry the Goal's context, so
    admission with a Goal refuses a Work without one.
  - Cache writes count as fresh input: Goal tokens are fresh input plus cache
    writes plus output.
  - For the attempts budget, an admitted Work that is not terminal counts as
    at least one attempt, so admission cannot outrun the budget before the
    first attempt runs. Terminal Works count their dispatched attempts.
  - Only the newest version of a Goal can be superseded, so the chain stays
    linear and every Work counts; `goal.new --supersedes` of an older version
    is refused, naming the newer one.
- Decision 3 (O2): `system mcp` is `packages/app/src/mcp.ts`, run by the thin
  client. Its tools are the table's `agent: true` rows, with JSON Schema from
  the row's params and the row's summary.
  - The hello's caller is `{ type: "orchestrator", operatorId, goal }` with
    `--goal`; the caller schema of the Work events has the same type.
  - Tool names are the method names, such as `work.submit`.
- Decision 4 (O2): the scope is a `scope` hook on the Host's rows, so the
  adapter decides nothing. Beyond the operations the decision names, an
  orchestrator also reads `work.replay` and `goal.show` only inside its Goal's
  chain; `task.new`, `artifact.put` and `workers.list` stay an agent's.
  Artifacts in scope are those a scoped Work's events name, and the context
  and base of its Task.

- Decision 5 (O3): `work.watch` and `work.unwatch` are `agent: true` rows,
  scoped like `work.show`. The Host sends `work.changed { workId, status, seq }`
  on a watching connection from one hook, `Host.onChange`, called in the
  commit lane after each append; it fires for the `terminal` event, which is
  how a Work ends, is held, or awaits approval. `work.watch { goal }`
  announces each new Work of the Goal (`seq` 0), which the adapter sends as
  `notifications/resources/list_changed`. `system mcp` serves
  `system://work/<id>` (read: `work.show`) and `resources/subscribe`.

## Consequences

- An agent session can be given a Goal and left to work. The operator keeps
  the budget, the approvals and `main`.
- No new mutable store. Goal spend is a fold over records System already
  keeps.
- Deferred:
  - an Orchestrator that System starts itself, on a schedule;
  - several Orchestrators per Goal;
  - Goal hierarchies.
- Milestone O ships as three steps:
  1. O1: `goal@1`, admission with a Goal, and the budget fold;
  2. O2: `system mcp` and orchestrator scope;
  3. O3: completion notices.
