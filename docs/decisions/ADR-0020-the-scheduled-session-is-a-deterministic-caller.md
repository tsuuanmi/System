---
id: ADR-0020
type: decision
status: accepted
date: 2026-11-28
summary: The Scheduled session is a deterministic caller driven by a Schedule, with no model in the caller's role; its passes are independent and re-enterable, it runs outside the bubblewrap layer, the next Attempt of a step must be able to run on any capable Account (so a Worker's session is never resumed), and it carries out a Release only for a commit the Operator approved.
related: [ADR-0004, ADR-0012, ADR-0016, ADR-0019]
---

# The Scheduled session is a deterministic caller

Accepted 2026-11-28 by the operator in a grilling session (questions Q1 to Q46; the evidence is
[[RES-0022]]). Acceptance does not mean the code follows it yet: the moves are Items sch-1 to sch-7 in
[STATUS.md](../../STATUS.md).

## Context

The purpose of the Scheduled session, in the operator's words: System runs by itself on a fixed schedule and reliably
finishes the work planned during the day. Measured on the 11 scheduled starts from 2026-11-18 to 2026-11-28:

- 2 did the planned work (23 of 24 Items merged), 8 had no Ready Item, and 1 did nothing and still ended `Succeeded`
  (2026-11-28: the layer hid the Node the caller's MCP server needs). On 2026-11-27 the 01:00 start failed and a later
  start saved the night. No start sent a notification. Both losses were in the launcher and its layer, none in the
  model.
- The caller was one `claude -p` for the whole night. On 2026-11-27 it read about 41.5 million cached tokens, about as
  many as the 23 Works it carried took as input, most of them in 90-second waits. Its usage is recorded nowhere.
- All 23 Tasks of that night were the Item's line behind a fixed prefix, as the prompt prescribes. The steps of the
  prompt are fixed rules; the one judgment in it, `hygiene` or `develop`, was used once.
- The layer's bind list is a shell copy of `packages/runtime-cli/src/adapters/sandbox.ts` and drifted from it.
- Of 109 reopened steps, 30 were taken by another Account and 16 by another Runtime; those Works ended as often in
  success as the ones the same Account repaired. Resuming a Worker's own session would save at most about 15 seconds
  and 1.5% of Claude Code's cost, and costs more than a fresh Attempt when the Worker skips only half of its reading.

## Decision

1. **No model in the caller's role.** A Scheduled session is a System command that applies fixed rules: take the Ready
   Items in STATUS order, claim, store the Task, submit, wait, record. It is still a caller, so
   [[ADR-0012]] holds: the Host picks nothing.
2. **The Item's line is the brief.** The Task of an Item is `Carry out Item <id> of STATUS.md: <the line>`. An Item
   must therefore name its files, its tests and what shows it is done. The Workflow is `develop` unless the line says
   `(workflow: <name>)`; a repository without its own Workflow files uses the install's.
3. **A pass is independent and can be entered again.** A pass reads the status, carries what is Ready and ends when
   nothing is Ready and none of its Works is running. A later pass takes what is left: Claims and the Host's refusal
   of a second Work for a running Item keep two passes apart. A start that finds the previous pass running is skipped,
   and a start missed while the machine was off is not run late.
4. **Limits.** Works run in parallel up to the free Accounts and an upper bound the Schedule may set; an Item whose
   Work failed gets one more Work, which reads the failed Work's verdict; after two failed Works the Item is skipped
   and reported. A pass has no time limit of its own: the Attempt's limit is the limit.
5. **A pass that did not do its job says so.** It ends non-zero, and a one-line verdict goes to the notifier. The
   report is generated from the Works' records; no model writes it. A check before the pass, at a time the Schedule
   names, tells the operator while they can still act that the Host answers, the Accounts are signed in and have
   Headroom, and Items are Ready.
6. **A Schedule says when and what.** It is a file the operator keeps on the machine (`~/.system/schedules/`), with
   times in systemd's calendar syntax, and one of two things to carry: the Ready Items of named repositories, or one
   Work from a fixed Workflow and Task (specified, not built: it waits for the first real use). `system init` writes
   one timer for each file and enables none. The command runs from the install, never from a checkout.
7. **Outside the layer.** This amends [[ADR-0016]] decision 5: the layer confines a model that holds tools, and a
   deterministic caller is System's own code, as the `system` command the operator types is. It opens the caller
   socket only. The shell copy of the layer is deleted.
8. **Any capable Account can take the next Attempt.** This is the reason behind [[ADR-0004]] decision 4: a reopened
   step receives the earlier change, the failing verdict and the failing checks as Artifacts, and nothing of the
   earlier Worker's session, so the Attempt can go to another Account or another Runtime. A Worker's session is not
   resumed.
9. **Releases.** A Scheduled session never approves and never writes Items. It may carry out a Release only for a
   commit the Operator approved ([[ADR-0019]] decision 3).

## Alternatives considered

- **Keep the model caller and add guards:** it keeps the one process that loses the rest of the night when it dies,
  the unrecorded cost and the 6-hour unit limit.
- **One short model call for each Item:** it still pays a model to copy the Item's line into a Task.
- **DSH's scheduler (`dsh-schedule`):** it can only deliver a prompt to a DSH agent, needs the agent loop the `system`
  profile does not mount, and records the delivery, not the result.
- **Claude Code, Codex and Antigravity through DSH headless, or through ACP adapters:** token counts get worse, not
  better, and the final result loses its schema ([[RES-0022]]).
- **Resume the Worker's session for a repair:** it ties the repair to one Account, carries the old Attempt's paths,
  bypasses the log's redaction, and the measured gain is about nothing.

## Consequences

- `tools/night-session.md`, the launcher script, its layer and its allowlist tests are deleted; "night" leaves every
  name but those in records of the past (sch-6).
- What the model caller did by judgment is lost: the "Items you propose" section of the report (empty in 9 of 12
  reports) and coping with a state no rule names. Proposing Items stays a daytime caller session's work.
- Items carry more: a line that does not name its files and tests gives a poor Task, with no model to repair it.
- Review this when an Attempt dies after many minutes of work and its partial change is lost: that is the case a
  resumed session would serve, and none occurred in 486 Attempts.
