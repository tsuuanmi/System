# PLAN.md — System next implementation: first-attempt acceptance

> **Status:** execution handoff, updated 2026-11-11. The next milestone is
> **RO, robust to outside failures** (section 3b; DG and SC below). The checklists and evidence of the finished
> milestones are in [PLAN.md at `aaa38f6`](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md); this file keeps one line
> each. This checklist is not an ADR or an alternate source of product
> requirements.

## 0. Read and align

- [Product Charter](docs/requirements/purpose.md), [accepted ADRs](docs/decisions/README.md)
  and [MVP scope](docs/requirements/mvp.md) define product/architecture truth.
  The terms are in [GLOSSARY.md](GLOSSARY.md).
- Recheck the actual current state before changing code; do not repeat
  finished work.
- **Deferred MVP-1 items** (operator, 2026-11-08): sandbox, egress denial,
  and a plugin unload with Work in flight (MVP failure tests 3 and 4) wait for
  a Worker that runs untrusted code or content.

## 1. Finished milestones

| Milestone | What it gave | Where |
|---|---|---|
| MVP-0 | Work and Artifact IDs that survive restart, Worker takeover, effects with intent and outcome, two YAML Workflows on one controller | PR #2 (`8b6a4c8`), [MVP-0 plan](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/PLAN.md) |
| B0–B4 Brainstorm | Three Worker attempts (Claude, Codex, synthesis) from one brief; evaluation in [RES-0008](docs/research/RES-0008-brainstorm-evaluation.md); the concurrency fixes | PR #2, [section 2 and 5](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md#2-execution-checklist-and-gates) |
| P | Stance per proposal by default, System publishes its own PRs and merges into `dev` ([ADR-0008](docs/decisions/ADR-0008-dev-integration-branch.md)) | PRs #5–#7 |
| H (releases R1, R2) | One long-lived Host ([ADR-0007](docs/decisions/ADR-0007-one-long-lived-host.md)), parallel steps per Account | PRs #8–#28, [H](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md#h--one-long-lived-host-adr-0007-as-amended-prop-0004-accepted) |
| O | Goals, `system mcp`, the Orchestrator, completion notices ([ADR-0009](docs/decisions/ADR-0009-goals-and-orchestrators.md)) | [O](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md#o--orchestrator-and-goal-adr-0009) |
| A (with the speed pass F), D, L1 | Faster checks (2 min 28 s), the Host restarts itself on new code, the remote sign-in races | PRs #31–#33 |
| OC | A replaceable Orchestrator: decisions, the brief, live progress, stalls, Sub-workflows ([PROP-0006](docs/proposals/PROP-0006-replaceable-orchestrator-and-code-checks.md)) | PR #39, [OC](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md#oc--a-replaceable-orchestrator-and-the-checks-as-a-sub-workflow-prop-0006) |
| CQ | Worker policy, `paths` checks, the merge queue by leased push ([PROP-0007](docs/proposals/PROP-0007-worker-policy-checks-and-merge-queue.md)) | PR #42, [CQ](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md#cq--worker-policy-faster-and-clearer-checks-and-a-merge-queue-prop-0007) |
| After CQ | Profile patches merge by `ref`, fflate 0.8.3, the Host-exit backstop, reads while the Host waits to upgrade | PRs #45, #46, #59, #62 |
| WW | Website Workers: Runtime `web`, generic Procedures on a UI map, Power by tier, the canary, `citations-v2`, `research-fanout`; built by System Works on branch `web-workers` | [WW](#ww--website-workers-that-work-built-with-website-workers-branch-web-workers) |
| DF | System develops System: Items in `STATUS.md` and `system status`, claims, tests first (`feature.yaml`: red check, tests frozen), a check the base fails too is held, one retry per failing check, `work wait` and `system mcp` across Host restarts and updates; 11 System Items merged by System Works in its last two days with no operator touch; DNA (Rust) the second repository; DF3 passed on the session takeover of 2026-11-09, whose questions became df-24, df-28 and df-31 (operator, 2026-11-10: no second run) | [DF at `ea71d80`](https://github.com/tsuuanmi/System/blob/ea71d80/PLAN.md#3-df--dogfood-decided-2026-11-08) |
| SC | Several Accounts per Runtime: Account identity and the provider's account ID (sc-1), roles `code.develop` and `code.tests` (sc-2), quota readers (sc-3), routing by Headroom under a Ceiling (sc-4), and the first remedies for outside failures (sc-7 to sc-13) | [SC](#3a-sc--scale-by-accounts-decided-2026-11-10), PRs #160 to #186 |
| RO | Robust to outside failures: 10 Items in a row (ro-7 to ro-16) with no Outside failure, measured from `work report` (ro-5); routing by Headroom with no preferred Account (ro-7), `status` shows the final Artifact (ro-10), research prefers the web Runtime (ro-12), MCP across an update (ro-13); the tests step moved to Claude Code (operator, 2026-11-13). Core 3,982 lines, docs 4,283. ro-15 failed on its change and moves to SS | [RO](#3b-ro--robust-to-outside-failures-decided-2026-11-11), PRs #196 to #212 |

Who built them: PRs #5–#36 were System Works, apart from #34 and #35 (the
operator's sessions); OC, CQ and the PRs after CQ were built by the
operator's sessions directly. DF turns that back.

## 2. Growth and feedback budgets (Charter 11 and 12)

Record the measures at the end of every milestone. Growth above budget is
justified in the milestone's row or paid for by removal. The core budget is
+10% per milestone from 3,403 lines
([ADR-0010](docs/decisions/ADR-0010-core-budget-rebaselined.md)); the older
columns are history, and the reasoning behind each is in [PLAN.md at
`aaa38f6`](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md#growth-and-feedback-budgets-charter-11-and-12).

| Measure | Baseline (PR #3, 2026-11-06) | Budget per milestone | R1 (end of H4, 2026-11-07) | H, before the pass | H, after the pass | O, before → after the pass | F, speed pass (2026-11-07) |
|---|---|---|---|---|---|---|---|
| Active core: `packages/work/src` + `packages/artifacts/src`, lines | 2,317 | +20% | 2,564 (+10.7%) | 2,913 (+25.7%) | 2,953 (+27.4%) | 3,006 (+29.7%) → 3,008 (+29.8%) | not measured |
| All package source, lines (`.ts` and `.mjs` under `packages/*/src`) | 4,081 | recorded | 5,299 (+29.8%) | 6,349 (+55.6%) | 6,374 (+56.2%) | 6,722 (+64.7%) → 6,735 (+65.0%) | not measured |
| Tests: `packages/*/tests`, `tests` and `test-support`, lines | not recorded | recorded | not recorded | 6,906 | 6,832 | 7,364 → 7,351 | not measured |
| Docs under `docs/`: lines (files) | 3,571 (37) | +20%, and no fact stated twice | 4,284 (43) (+20.0%) | 4,557 (44) (+27.6%) | 4,557 (44) (+27.6%) | 4,648 (44) (+30.2%) → 4,283 (44) (+19.9%) | not measured |
| Unit check, clean worktree | ~1 min | under 2 min | 39 s (install, build, typecheck, test) | not measured | not measured | not measured → 1 min 14 s (install 7 s, build and typecheck 29 s, test 37 s) | 1 min 14 s → 1 min 14 s, now four checks (install 9 s, build 23 s, typecheck 6 s, unit 38 s); install and build run once for all checks |
| All required checks (`.system/checks.yaml`) | ~7 min | under 10 min | about 5 min (docs 2 s, unit 39 s, smoke 4 min 14 s) | not measured | not measured | not measured → about 7 min 20 s (docs 2 s, unit 1 min 14 s, smoke 6 min 9 s, run beside another job) | 7 min 20 s → 2 min 28 s (docs 0.4 s, install 9 s, build 23 s, typecheck 6 s, unit 38 s, smoke 1 min 12 s); goals met: all checks under 3 min, smoke under 2 min. Measured with `env -i PATH LANG HOME=<fresh> CI=1 sh -c`, one shared HOME, from a clean copy. Smoke 5 runs in a row: 70/70 each, 73 to 76 s, no leftover processes |
| Flaky tests known | 0 | 0: a flaky test is fixed before features | 0 | 0 | 0 | 0 → 0 | not measured |
| Host `recordBytes` | n/a | recorded | 11,308 for three Works (Software Engineering, Research and a direct Task, fake Workers) | not measured | not measured | not measured | not measured |
| Tokens per Work | n/a | Fresh input, cache read, cache write, output, recorded per milestone; usage includes every turn of an attempt and, for Claude Code, subagents (`modelUsage`) and the CLI's own `costUsd`; USD figures are API-equivalent estimates, not what the subscription is billed | | not measured | not measured | not measured | not measured |

| Measure | OC, after the pass (`a4862d7`) | CQ (`6d92315`) | DF9, hygiene pass (`f752e79` → change) | DF, before df-28 (`1029250`) | SC close (`3af21cf`, 2026-11-11) | RO, hygiene ro-6 (`6a68258` → change) |
|---|---|---|---|---|---|---|
| Active core, lines | 3,403 | 3,420 | 3,391 → 3,255 | 3,601 (+10.6% on DF9): each DF defect fixed by a mechanism (claim, red check, base re-run, wait); accepted at DF's close (operator, 2026-11-10) as DG's baseline. df-29: 3,606 → 3,599. The gap to DF9's 3,255 stays: those mechanisms are behaviour the tests pin, and a helper extracted from the verdict and dispatch code added more lines than it saved. Closing it means dropping one (operator decision: the `claim` command, about 60 lines, or the staleness note, per-source retry or slot wait in `live()`) | 3,882 (+6.8% on DG's 3,636, within +10%): routing by headroom (sc-4, +140), publish retry (sc-7), resume after restart (sc-8), re-runs (sc-9, sc-13); dg-11 gave back 36 | 3,953 → 3,941: dead `Artifacts.ofKind` and an orphan comment deleted. 59 above SC's 3,882: the rest is behaviour the tests pin; closing it needs the operator decision on the `claim` command (about 60 lines) |
| All package source, lines | 11,062 | 11,366 | not measured | 11,191 | 12,191 | not measured |
| Tests, lines | 9,540 | 9,712 | not measured | 13,136 | 16,435 | not measured |
| Docs under `docs/`, lines (files) | 4,821 (46) | 4,985 (48): over the 4,285 limit by the WW programme's documents | 5,417 (48) → 4,257 (39) | 4,311 (39): over the limit. df-29: 4,314 → 4,284 (39) | 4,350 (39): over the 4,285 limit by 65; SC's decisions live in this PLAN, not a PROP | 4,373 → 4,283 (39), under the 4,285 limit: restated procedure left to its one home (host.md, bin/README, web-worker README, ADR-0007). ro-16: 4,296 → 4,283 (39), under the limit again: the runbook's following-a-Work, dev-branch and status text left to its homes (app README, effects README, ADR-0008) |
| Required checks | 5 min 44 s at a load of about 270 | 4 min 45 s at a load of about 210; 4 min 20 s on a quiet machine, about 2 min 20 s without WW's three headed-browser test files | not measured | about 2 min (df-27: 6 checks, 124 s) | about 2 min 30 s on a quiet machine (docs 1 s, install 10 s, build 30 s, typecheck 10 s, unit 27 s, smoke 71 s); timeouts and flakes at loads of 200-460 | not measured |

Every milestone ends with a **simplification pass**. A System Work (Sonnet)
proposes deletions and simplifications: dead code, unused abstractions,
duplicated tests, docs that restate others. The operator reviews it like any
PR. After each milestone, the Sonnet code review's Standards axis also checks
the code against Charter items 8, 11 and 12.

## 3. DG — First-attempt acceptance (decided 2026-11-10)

**Aim:** a Work is accepted the first time, without a human or a session
finding the cause of a failure and submitting again. In DF's last night,
3 of 11 Items needed that (PLAN DF at `ea71d80`).

- **Measure first** (Charter 9): run about 10 real Items of System and DNA,
  in parallel where Accounts allow, on the release with df-30 and df-32, and
  add nothing until the measure says what is missing.
- **Measures**, per Item: *first-Work acceptance*, the Item merged by its
  first Work (its automatic retries included); *human diagnosis*, an Item a
  person or a session had to diagnose and submit again (recorded on its
  STATUS.md line). Target: at least 85% and none over 10 consecutive Items.
- **Budget:** the active core does not grow (3,599 lines at DF's close). If
  a diagnose step is needed, it lives in Workflow config and Worker
  instructions, not in the controller.
- *First measure, 2026-11-10 (14 Items, all merged; no slot wait):
  first-Work acceptance 12/14 (86%): DNA 5/5 (software-engineering.yaml),
  System 7/9. Human diagnosis 1 (dg-1). Both misses were System defects, not
  the Items': a docs step with nothing to change failed the Work (dg-7), a
  flaky leftover-process test (dg-9), a frozen test the implement step could
  not call wrong (dg-8), and a reopened step's checks chosen against the
  previous attempt, which let DNA gates-1 merge without its Rust gates (dg-6);
  all four fixed in DG and released. 7 consecutive Items accepted first since.
  In every feature.yaml Work (5 of 5 after the release) implement first edited
  a frozen test and tests-frozen sent it back: one more implement attempt
  each, about 15 minutes. Core: 3636 lines.*
- *Stopped for review (operator, 2026-11-10) before 10 consecutive Items;
  open: dg-10 and dg-11.*

## 3a. SC — Scale by Accounts (decided 2026-11-10)

**Aim:** more quota, so more Items run at once. Every Account is the
operator's own; System with several users is a later milestone. This is the
"adaptive routing on a measured need, quota exhaustion" of section 4: the
operator gives few Items at once today because one Claude Account runs out.

Decisions (operator, 2026-11-10; Items sc-1 to sc-6 in STATUS.md):
- **Account identity (sc-1).** A `ref` is a stable handle never reused
  (`claude-code/c1`, `codex/x1`), with a `label` for people and
  `priority: primary` on the main Account instead of the name `default`.
  At registration System reads the provider's own account ID (Claude Code's
  `oauthAccount` in `.claude.json`, Codex's `account_id` in `auth.json`),
  records it and refuses two refs on one provider account, whose quota
  would count twice. Kubernetes' name and uid is the standard considered.
- **Roles, not shared capabilities (sc-2).** `code-write` stays the
  permission to write the checkout; a new role `code.develop` marks the plan,
  implement and docs steps, given to the Claude Accounts only. Codex keeps
  `code.tests`. Workflow config and profile only.
- **Quota readers (sc-3).** Port from System 1 (`tsuuanmi/system`
  `15e2bd5`) only its two readers, which spend no model turn: Claude Code's
  `get_usage` control request (`runtime-claude-agent-sdk/src/limits.ts`) and
  `codex app-server`'s `account/rateLimits/read`
  (`runtime-codex-sdk/src/rate-limits.ts`): the 5-hour and weekly windows,
  as a share used and a reset time. Not its ledger, pools or reservations.
  System 1 verified Claude Code 2.1.308–310 and Codex 0.164.0; this machine
  runs 2.1.322 and 0.166.0, so the shapes are checked again. The row returns
  each reading (`quota(ref)`, cached 10 minutes); recording it as an
  observation in the record, so replay stays deterministic, is left to sc-4,
  because sc-3 may not change `packages/work/src`.
- **Routing by headroom (sc-4, after sc-1 and sc-3).** Among capable
  Accounts with a free slot, the primary takes the step while both of its
  windows are under 80% used; otherwise the free secondary with the most
  headroom (its fuller window decides, ties by profile order). Balance is
  of quota spent, not of steps counted. When every capable Account is over
  80%, the step waits (`waiting: quota`, with the earliest reset) without
  failing or spending an attempt. An Account whose usage cannot be read
  ranks last but stays usable, so a CLI upgrade cannot stop all work.
  Supersedes the first half of df-13.
- **Antigravity CLI (sc-5).** A `research.yaml` Work first: a headless
  mode, machine-readable output, usage and quota reports, and what it would
  give that the current Workers do not. An adapter only with that reason.
  An API Worker is an Account with an API key on an existing CLI, never a
  model loop of System's own (ADR-0001).
- **Measure (sc-6).** The operator signs in three more Claude Accounts and
  configures the second Codex Account (one slot each), `maxConcurrentChecks`
  goes to 4 (back to 2–3 if the required checks pass 10 minutes); then
  about 6 Items at once, measuring time waited for a slot or quota, the
  checks' time under load, rate-limited attempts, and DG's first-Work
  acceptance.
- **Not changed:** Workflows are already DAGs (`dependsOn`; steps that are
  ready run at once); `feature.yaml` stays a chain, since each stage works on
  the previous change. Parallelism comes from more Items at once.
- **Budget:** sc-4 grows the active core (routing); the growth is recorded
  here at SC's close against DG's 3,636 lines. sc-4 itself: 3,636 → 3,776
  (+140: the pure ranking `headroom.ts` 72, the controller's wait and reading
  50, registry 31, live and status 6, and the verifier/effect `route` shrank).
- *Measure (sc-6), 2026-11-10 20:39 to 2026-11-11 10:48: 8 Items at once
  (sc-7 to sc-13, dg-11) on 4 Claude and 2 Codex Accounts, Claude primary at
  2 slots, `maxConcurrentChecks` 4. All 8 merged. First-Work acceptance 3/8
  (sc-9, sc-10, sc-11); 2 more after an operator retry (dg-11, sc-13); 3
  merged by hand after their own checks passed (sc-7, sc-12: a publish
  conflict or an inconclusive merge check; sc-8: an existing smoke test the
  plan missed, the one defect of an Item's own making). About 11 outside
  failures, none caused by a change: 6 checks failing or inconclusive at
  machine loads of 200-460 (the machine is shared by about 90 users), 3
  attempts on codex/default after its 5-hour window reached 100% ("out of
  credits": not matched as a limit, and a 10-minute-old reading chose it;
  sc-14), 1 publish conflict, and `system work wait` exiting 0 when the Host
  answered slowly. Routing worked: steps spilled to c2, c3 and c4, and Codex
  moved to x2 at its primary's 100%. sc-1 caught the second Codex login on
  the same account at its first registration. Claude quota stays unreadable
  with `setup-token` tokens (no profile scope).*
- **Closed 2026-11-11** (operator). What SC did not settle goes to RO.

## 3b. RO — Robust to outside failures (decided 2026-11-11)

**Aim:** a Work never fails, and is never held, for a reason outside its
change. SC's measure found the code of the Items sound and about 11 outside
failures in 8 Items; a scheduled session (section 4) is worth having only
after this.

Decisions (operator, 2026-11-11):
- **Measure:** each failed or held Work, and each operator touch, is an
  *Outside failure* (load, quota, restart, conflict, a slow Host) or a
  failure of the change. Target: no Outside failure over 10 consecutive Items.
- **Tests stand load first** (Charter 12): no short timeouts, waits on a
  condition, never on time. A load gate on the checks comes only if the
  measure shows that is not enough.
- **Only a human verifies again, approves or denies.** Operator touches go
  down through bounded, declared automatic re-runs (sc-9, sc-13, sc-14), not
  through giving an agent that authority, even when asked in chat.
- **Budget:** the active core stays within +10% of SC's 3,882 lines; a new
  mechanism replaces a step a person does today.

Review of 2026-11-12 (operator; read-only counts from the Host's store: 471
Works since 2026-11-05; feature.yaml 21 of 41 succeeded, of the 20 failures
8 Outside, 5 tests and implement out of sync, all before dg-13, 3 System
defects since fixed, 2 of the change, 2 denied on a stale base):
- **Measure first.** At ro-5's merge the active core is 3,953 lines (+1.8%
  on SC, not recorded before) and docs 4,373 lines (over 4,285). ro-6, a
  hygiene pass, comes before the RO measure; ro-7 to ro-12 count toward its
  10 Items. A load gate waits for the measure, as decided on 2026-11-11.
- **No preferred Account by name** (ro-7). `claude-code/default` took 344
  attempts and c2, c3 and c4 together 12: with every Claude Account
  unreadable, the tie went to registration order. Headroom decides; a tie
  goes to the Account with the fewest attempts that day; a reading from
  `rate_limit_event` survives a Host restart. `priority: primary` goes; no
  profile weights until an Account is paid by the API.
- **Refs `<runtime>/<n>`** (ro-11), replacing sc-1's `c1`/`x1` advice; `label`
  is for people; old refs are retired, never reused, and old records keep them.
- **Red re-runs once** (ro-8) before it holds, as sc-13 does for checks: red
  never failed and its 8 inconclusive verdicts all waited on the operator.
- **Tests and implement stay on different Providers.** A contract of
  interfaces in the plan waits until a Work in the measure is out of sync.
  *Reversed 2026-11-13 (operator):* ro-7 and both ro-15 Works failed on
  tests and implement disagreeing, so the tests step takes `code.develop`
  (Claude Code) like plan and implement; `code.tests` (Codex) returns once
  feature.yaml is stable.
- **Artifacts stay as they are;** `system status` shows the final one (ro-10).
- **The web Runtime is used** (ro-12): research's investigate step prefers it
  (research 197 of 224 web attempts succeeded; none since 2026-11-08), and its
  headed-browser tests run only when its paths change (ro-9).

RO measure, first Items (overnight session of 2026-11-12/13, operator away;
releases `8cc1e2c` and `430ae55`): **0 Outside failures in 6 Items.**
- ro-7 merged with 2 change failures: the plan missed the old tests that
  pinned `priority: primary`; implement objected (dg-8) and tests was
  reopened once. The first tests/implement mismatch since dg-13; a plan
  that lists the existing tests to change would have caught it.
- ro-8 changed nothing: sc-13 already re-runs red (the Item was written
  without reading the code; ticked by hand, PR #200).
- ro-9 (narrowed, PR #201: `web` was already selected by `paths`, and every
  smoke test boots a Host), ro-10, ro-11 and ro-12 merged at the first
  attempt.
- After ro-7, steps spread over the Claude Accounts (ro-8's plan went to
  `claude-code/c2`). `research.web` is given to both web Accounts in the
  operator's profile (backup `profile.yml.bak-before-research-web`).
- Open: 4 more Items for the 10; core 3,982 lines (within +10% of 3,882);
  docs 4,296 lines, 11 over 4,285 after ro-11's rename procedure; the
  `claim` command decision (ro-6) is the operator's.

Review of 2026-11-13 (operator), what returns most next:
- **Return is the operator's time** (touches, hours watching); throughput
  and quality must not drop. The bottleneck is no longer a Work but a person
  writing Items, submitting, waiting and releasing.
- **Next milestone: the scheduled session** of section 4, after the RO
  measure. Its four remaining Items prepare it: ro-13 (MCP across an update),
  ro-14 (the plan names the tests to change), ro-15 (Satisfied), ro-16 (docs
  under budget; the real research Work work:90e7b0fc ran on
  `web/chatgpt/default` and passed citations, so the web Runtime needs no fix).
- **The scheduled session** drives `todo` Items into `dev` only; a Release
  stays the operator's (ADR-0008) unless the operator hands it over for one
  session. It takes only Items the operator wrote and proposes new ones in its
  report.
- **Repositories:** System and DNA only, for now.
- **`claim` stays** (a scheduled session needs it); 3,882 stays the budget
  baseline, with no target below it.

## 3c. SS — The scheduled session (decided 2026-11-14)

**Aim:** the operator writes Items and releases; a session started on a
schedule drives the `todo` Items into `dev` overnight and leaves a report.
RO closed with 10 Items in a row without an Outside failure.

Decisions (operator, 2026-11-14):
- **A caller outside System.** df-1 removed the Orchestrator that System
  started itself (ADR-0009); the scheduled session is a Claude Code session
  run as `claude -p` by a systemd user timer (the standard the web canary's
  timer already uses), reading its prompt from a file in this repository, so
  any session can replace it. System gains no model loop (ADR-0001).
- **One night:** the `todo` Items in STATUS order, one at a time; at most 6
  Items or about $15 (API-equivalent) a night; an Item whose Work is held or
  that failed twice is skipped and reported; no `todo` left ends the night.
  It writes no Items and never releases (ADR-0008), unless the operator hands
  a Release over for that night.
- **The report is an Artifact** (Works, Items done, Items skipped and why,
  Items it proposes, the release commands for the operator), its ID sent to
  the operator's phone.
- Items: ro-15 (Satisfied, redesigned), ss-1 to ss-4 in STATUS.md.

### W — ChatGPT Website Worker (PROP-0005, after H release R1)

- [ ] Design: [PROP-0005](docs/proposals/PROP-0005-chatgpt-website-worker.md)
  (accepted 2026-11-07). The operator accepted the Terms-of-Use risk for their own account
  (2026-11-06).
- [x] Re-run the three research Works (tokens, existing drivers, risks) after
  the verifier fix V1. *(2026-11-07, verifier v2, ratio 0.5: tokens `851ec77c`
  5/8 quotes confirmed, drivers `12143a0f` 5/7, risks `8aaea4d6` 8/9 (one
  page 403); all accepted, the unconfirmed listed in each verdict; 82-108 s
  and about $0.22-0.29 (estimate) each.)*
- [x] Build after R1: the `chatgpt-web` Runtime on Playwright, a dedicated
  signed-in profile, one prompt per attempt, completion detection, answer
  and cited links as outputs, each exchange recorded as a `conversation@1`,
  and deterministic tests on a local fake page. *(2026-11-07, W1: PROP-0005
  accepted; `system workers login`, cookie import; not enabled in the bundle;
  the real-site run, `SYSTEM_REAL_WEB=1`, is still to do.)*

- [x] W2. Remote sign-in over SSH, as System 1 does (operator, 2026-11-07).
  *(2026-11-07: pure Node, no VNC and no new package.)*
  - `system workers login <ref> --remote` opens the account's profile headed
    on its own Xvfb and serves a viewer on 127.0.0.1 behind a random 32-byte
    token: a CDP screencast over Server-Sent Events, input sent back by POST,
    **Save** and **Cancel**, a 15-minute TTL. The CLI prints the
    `ssh -L <port>:127.0.0.1:<port> <user>@<host>` line and the URL.
  - No CDP port is exposed (Playwright's pipe). A human clears a challenge in
    the viewer; System never does.
  - **System never runs the browser headless** (operator, 2026-11-07): attempts
    and login use a real headed Chrome on the operator's `DISPLAY` or a private
    Xvfb it stops with the attempt; the `headless` option is gone; without
    Xvfb the account is `unavailable`.
  - Reference: System 1, `docs/design/browser-runtime.md` ("remote" flow).
  - Cookie import (`--cookies`) stays as the quick path.
  - Verified here by the unit and Host tests; the browser tests are skipped
    where a headed Chrome does not start on an Xvfb (the Chrome 95 on this
    machine crashes on start when headed), so a headed run is still to do on a
    machine where it starts.
  - Parallel-merge interaction fixed (L1) *(2026-11-07)*. W2, A (faster
    checks, tests in parallel) and D each passed alone; their merge turned
    `dev` red. Cause, two races in W2's code, both made likely by the parallel
    runs: (1) `agentWorker` closed the browser from the abort and again at the
    end, and the second `close()` returned before Chrome had exited, so the
    attempt ended with Chrome and its profile still in use (the test then read
    a dead or half-gone process, and the file's cleanup hit a profile still
    being written); (2) `startXvfb` took the first X socket it saw, which
    could be another Xvfb's when two started from the same display number, so
    two attempts shared a display and one Xvfb exited under its browser.
    Fixed in the code (`chatgpt.ts` shares one close; `display.ts` takes a
    display only when its lock names its own Xvfb); a test starts four Xvfbs
    from the same number. Not the tests' fault, and not Chrome's zygote.
- [x] W5. Port System 1's browser runtime and make `dev` green again
  (operator, 2026-11-07). *(Real-site result pending: the operator runs it.)*
  - Evidence from the real site: a signed-in account reported as challenged (a
    false positive), and Turnstile looping on a second account. Cause by
    comparison: Playwright's default launch advertised automation and used
    `--no-sandbox`, `--password-store=basic`, `--use-mock-keychain` on
    Chromium 136. System 1 launches a genuine Chrome and works.
  - `playwright-core` is replaced by `patchright-core` 1.63.0 (System 1's pin),
    launched with System 1's `CHROME_ARGS` and `ignoreDefaultArgs`; Chrome is
    chosen as System 1 does (`chrome.ts`, `chrome.lock.json`: configured path,
    `CHROME_PATH`, a recent system Chrome, else Chrome for Testing 155.0.8059.39,
    installed on first use; it runs on this Ubuntu 20.04, glibc 2.31). Page
    state, Chat mode and the Work refusal are System 1's logic in a selector
    table and scripts, `SELECTORS.version` 2. PROP-0005 records that System 1
    used VNC (real X input) and that CDP-dispatched input is the difference
    left if a challenge still loops.
  - `dev` was red: Chrome aborts with `Socket path too long` when `TMPDIR` is
    deeper than about 55 bytes, and the verifier's throwaway HOME is. The
    headed tests were **skipped** there (the probe saw Chrome die), so the
    required checks passed on L1 without running them: a coverage gap. Fixed
    in the code (Chrome gets a short `TMPDIR`) and in the checks: a headed
    Chrome that cannot start now fails these tests (`SYSTEM_SKIP_HEADED=1`
    opts out); the tests use the Chrome the Runtime chooses, installed once
    into a cache shared by the test processes.
  - `bin/system` supervised only when `host` was `args[0]`; it now finds `host`
    after DSH's options (`--patch X host --supervise`).
  - The one change to `pnpm-lock.yaml` is the dependency swap itself
    (`playwright-core` out; `patchright-core` and `@puppeteer/browsers` in),
    which `--frozen-lockfile` needs.
- [x] W7. Port System 1's ChatGPT web driver, its UI map and its UI engine
  (operator, 2026-11-07, said twice). *(Real-site result pending: the
  operator's agent runs `SYSTEM_REAL_WEB=1 node --test tests/real-web.test.ts`
  after the merge.)*
  - Why: W5 and W6 re-implemented parts of System 1's driver as a small
    selector table and met problems System 1 had already fixed (a stale send
    selector, `?temporary-chat=true` navigation aborted, a false challenge).
    System 1 works against chatgpt.com, so its logic is copied, with its
    comments, and not written again.
  - New package `packages/web-driver` ([README](packages/web-driver/README.md)):
    System 1's `ui-ops` (engine, map, locate, outline, network, answers, site,
    heal), its `provider-chatgpt-web` driver, UI map and fake site, and only the
    parts of `provider-core` and `libs` they import. Each file names its source
    path and System 1's commit (`f199a277`); the README lists every difference
    and why (no Cordis glue; reports go to the attempt's log, heal off; the
    map schema is checked with `ajv` without format checks; parameter
    properties as fields; a fixture without `otpauth`). Dependencies: `yaml`
    2.9.1 (System 1's pin) and `ajv` 8.20.0 (already in the lockfile through DSH).
  - `packages/agents/src/chatgpt.ts` uses the driver: `ask` opens a temporary
    chat in Chat mode (the operator's default), checks the sign-in, sends and
    waits; the answer's Markdown comes from the page's Copy. Deleted: the
    `SELECTORS` table, the page-state and send/wait scripts, `classify`,
    `settle` and `pageState`, the stage `send` and its timeout, and the tests
    the ported ones cover. Kept: never headless, the private Xvfb, the
    persistent session-bound profile, the `conversation@1` record, the output
    blocks, cancel and the attempt time limit. The remote login's Save check is
    the driver's `checkAuth`.
  - Test evidence here: the ported engine tests (9), the driver tests against
    the ported fake site (3), the Runtime's attempt tests against it (24), the
    remote-login tests (11) and the booted `chatgpt-web` smoke test (4) pass on
    a headed Chrome on Xvfb.
  - **Growth recorded** (lines of `.ts` and `.mjs`; the baseline is `dev` at
    `a63457f`): the active core (`packages/work/src` + `packages/artifacts/src`)
    is 3,076 before and after, **unchanged**; all package source 7,705 → 10,469
    (+2,764: `packages/web-driver/src` 3,006, `packages/agents/src` 1,935 →
    1,693); tests (`packages/*/tests`, `tests`, `test-support`) 8,603 → 9,421
    (+818: System 1's fake site is 672 of them). The growth is the ported
    code, which is the decision; it is outside the core's budget, and the
    next milestone should check that none of System 1's unused procedures
    (Deep research, deletion, credential sign-in, heal) is kept without a use.
  - `pnpm-lock.yaml` is not part of this change (instructions): the new
    workspace package needs its importer entry (`yaml`, `ajv`, `patchright-core`
    under `packages/web-driver`, `@system/web-driver` under `packages/agents`),
    which `--frozen-lockfile` wants; regenerate it with
    `corepack pnpm install --no-frozen-lockfile` when merging.
- [x] W8. Read a ChatGPT answer's output blocks with their fences (follow-up
  to W7; operator's real-site run, 2026-11-07).
  - Evidence: the whole turn worked through `packages/web-driver`, and ChatGPT
    wrote a `report` and a `sources` block, but the attempt failed with "wrote
    no output block": the answer recorded was the rendered text (header and
    content, no fences). No "copy refused" note was logged because System 1's
    `markdownOf` returns the rendered text silently when Copy's code blocks do
    not pair with the page's `pre code`.
  - Fix, from System 1's own `answer.code` map entry: when the answer text has
    no fence, `withFencedBlocks` fences each `pre code` block again with its
    header as the info string (README, "Fences without Copy").
  - Red test first: driver tests where the fake page's Copy gives text without
    fences, and where it gives nothing, must still fill `report` and `sources`.
- [ ] W3. Two ChatGPT accounts for Brainstorm (operator, 2026-11-07). With
  temporary chats, two signed-in accounts (`chatgpt-web/default`,
  `chatgpt-web/second`) can each give an independent proposal. A Brainstorm
  variant in `workflows/experiments/` routes `idea-a` and `idea-b` to the two
  ChatGPT accounts through role capabilities. Compare it with the Claude/Codex
  default on real briefs, judged by the Sonnet evaluator (B3's method).


### WW — Website Workers that work, built with Website Workers (branch `web-workers`)

Merged into `dev` on 2026-11-09 by the operator's decision, with the canary
at 94% (47 of 50 at Power Medium, verifier `citations-v2`, both Accounts):
every failure was the model leaving out an output block, none a UI stage or
a verifier rejection. Its detail is in the branch's history (PLAN.md at
`6af50a7`). What it gave: Runtime `web` with `site: chatgpt` and Accounts
`web/chatgpt/<name>`, generic Procedures on a UI map (the legacy driver
removed), Power by tier, a circuit breaker per Account, the canary, the
`citations-v2` verifier, and the Workflows `second-opinion`, `debate`,
`brainstorm` on web Accounts and `research-fanout`. Left open:
- the model leaving out an output block (about 6%): the automatic fresh
  attempt is a DF Work after DF0b; a repair turn in the same chat was
  proposed (WW6m), not decided;
- `tests/chatgpt-web.test.ts` flaky under load: its failure now names the
  registration's reason (WW6l), the cause is not reproduced yet;
- deferred by measurement: a long-lived Chrome per Account (step 3), with
  the operator's open questions; a second Site; `digest`.


## 4. Future, not current gates

- [ ] A session that System starts on a schedule, to drive Items unattended: now milestone SS (section 3c).
- [ ] Research quality capabilities (source snapshots, citation consistency,
  claim-to-evidence checking) as separately selected verifiers. *Trigger: a
  Research Work whose accepted report the operator finds wrong because a
  source changed or a claim was not supported. Until then, V1's ratio policy
  (unconfirmed quotes are listed, not hidden) is the bar (2026-11-06).*
- [ ] Source fetching and snapshots with content identity (the Website
  Worker's layer 2), with the trigger above.
- [ ] Optional Skill, LSP, web-fetch or another Worker adapter only if a Work
  fails for want of one and the pinned DSH plugin can satisfy the System
  contract without duplicating the model loop.
- [ ] Adaptive routing only on a measured need, such as quota exhaustion.
