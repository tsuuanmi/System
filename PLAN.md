# PLAN.md — System: finished milestones, open work and the standing decisions

> **Status:** updated 2026-11-18. Open work is the Items of [STATUS.md](STATUS.md) (state derived by `system status`)
> and section 3 below. Each finished milestone is one line in section 1; its checklist, evidence and decisions as
> written then are in [PLAN.md at `97a1adb`](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md) (sections 3 to 3h), and for the older ones in
> [PLAN.md at `aaa38f6`](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md). This file is not an ADR or an alternate source of product requirements.

## 0. Read and align

- [Product Charter](docs/requirements/purpose.md) (which holds the MVP scope), [accepted ADRs](docs/decisions/README.md)
  and [GLOSSARY.md](GLOSSARY.md) define product and architecture truth. Recheck the current state before changing code.
- **Deferred MVP-1 items** (operator, 2026-11-08): sandbox, egress denial, and a plugin unload with Work in flight
  (MVP failure tests 3 and 4) wait for a Worker that runs untrusted code or content. The trigger is judged not met
  (2026-11-16): Workers run only the operator's own repositories with lockfile-pinned dependencies, and the Website
  Worker reads pages but runs no code from them; rb-5's secret scan and rb-4's permission-flag tests come before a sandbox.

**Standing decisions of finished milestones** (each has this one home; the reasoning is in the pinned file):

- Only a human verifies again, approves or denies; operator touches go down through bounded, declared automatic
  re-runs, never by giving an agent that authority (RO, operator, 2026-11-11). A load gate on the checks waits for a measure.
- A Claim never expires and `force` is the only takeover; stall means no timeout that aborts; Item dependencies are
  `(after: ...)`, a DAG within one repository; three Outside failures in a row on a step hold the Work; a changed
  verifier or an inconclusive verdict on the merge commit needs an Approval of that commit; the human/agent boundary is
  advisory within one OS user ([ADR-0011](docs/decisions/ADR-0011-human-caller-needs-a-terminal.md)) (CM, 2026-11-14).
- ROI of an Item is what it improves in later Items (Items merged on their first Work, cost per merged Item, operator
  minutes per Item, Escaped defects) over its own cost and operator minutes. Invariants are prose in a Task and the
  changed tests are disclosed, never frozen tests or a model review. Order after TR: bootstrap, then unattended scale (TR, 2026-11-14).
- Bootstrap is read-only first (`plan`, `check`; `apply` waits); the first checks file is a draft a human commits,
  because admission refuses a Work without one; several repositories on one Host are accepted under today's limits:
  GitHub `origin`, `dev`, one token (BS, overnight session 2026-11-15, the operator may change them).
- Capabilities are an Ability (declared by the Runtime adapter), a Role (`<workflow>.<part>`, granted in the profile)
  or a Tier (`tier.*`); a rename is expand, then contract; the citation verifier stays as strict as it is (NM, 2026-11-15).
- A `checks.yaml` key or verifier version is pinned a release after the one that added it, because the running Host
  refuses what it does not know (Q0, Escaped defects 3 and 7; [verifiers README](packages/verifiers/README.md)).
- Unattended-scale isolation, when it comes: bubblewrap, the same OS user (the shared server gives no root), `$HOME`
  hidden with an allow-list, a per-attempt clone with read-only alternates, network kept, CLI Workers only (2026-11-15).
- Property-based and formal verification wait for an Escaped defect of their kind. pstack (MIT, Lauren Tan) is reused
  selectively as Worker procedures and a source for Guardrails, never as a control plane or a substitute for System's
  verdicts; copied files keep attribution and the upstream commit (FL, 2026-11-15). The Guardrail rule (Q8) is in
  [workflows/README.md](workflows/README.md).
- A task's context pack is written by the caller who read the code, not by a plan step (FL, 2026-11-15; `develop.yaml`).
- Release boundary (RB, operator, 2026-11-16/17): the `upgrade` check (rb-1) rehearses the update from `main`, path-limited; a git `pre-push` hook (rb-2) covers hand pushes; TR's close criterion stays and RB is its path.
- Q31: the failure-cause question gains `flaky` and `process` (cls-3). Q34: `docs` runs the impact check (dc-1). Q35: the headline measure and Escaped defects come from records (ms-1).
- Q36: open work lives in STATUS, not in a session's chat. Q37: one Item fits one Worker attempt; the caller splits a Done when with independent parts. Q38: a `toolShare` above 1 is investigated (tool-1).
- From the grilling of "Verified Feedback Loop v2" (2026-11-16): no new measures, no confidence in failure classes, no recovery-decision component in the core (a recovery rule is a Workflow declaration); a Task's Done when is guidance and only a Verifier's criteria gate. rb-3, rb-4, cls-4 and cls-5 are the fixes; `outside.test.ts` holds the b131dd34 and c6e7cba1 cases.
- Dependencies and priority (2026-11-17): `after:` names only a real dependency; priority is the order of lines in STATUS.md; independent Items run in parallel, each in its own worktree. Intent is an Artifact (in-1 to in-3); the scheduled session runs on System only until DNA has open Items.
- Classifier research (2026-11-17): work:3cb46bef (economy model as classifier; report sha256:9645d599fe3d30963d5d73aa4a6104677158e6dc20a582fe2113f59a265ddef6, citations passed) and work:bbbf12bc (Jev by TypeSafe AI; report sha256:02edfb76c7842b7552e94d309509f4b19a03269c61d0ab6e4b339f94691dcfff, citations not verified, web-1).

## 1. Finished milestones

| Milestone | What it gave | Where |
|---|---|---|
| MVP-0 | Work and Artifact IDs that survive restart, Worker takeover, effects with intent and outcome, two YAML Workflows on one controller | PR #2 (`8b6a4c8`), [MVP-0 plan](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/PLAN.md) |
| B0–B4 Brainstorm | Three Worker attempts (Claude, Codex, synthesis) from one brief; the B3 result is in [brainstorm composition](docs/architecture/brainstorm-composition.md); the concurrency fixes | PR #2, [section 2 and 5](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md#2-execution-checklist-and-gates) |
| P | Stance per proposal by default, System publishes its own PRs and merges into `dev` ([ADR-0008](docs/decisions/ADR-0008-dev-integration-branch.md)) | PRs #5–#7 |
| H (releases R1, R2) | One long-lived Host ([ADR-0007](docs/decisions/ADR-0007-one-long-lived-host.md)), parallel steps per Account | PRs #8–#28, [H](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md#h--one-long-lived-host-adr-0007-as-amended-prop-0004-accepted) |
| O | Goals, `system mcp`, the Orchestrator, completion notices (ADR-0009, retired; Goals removed in DF) | [O](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md#o--orchestrator-and-goal-adr-0009) |
| A (with the speed pass F), D, L1 | Faster checks (2 min 28 s), the Host restarts itself on new code, the remote sign-in races | PRs #31–#33 |
| OC | A replaceable Orchestrator: decisions, the brief, live progress, stalls, Sub-workflows (PROP-0006, retired) | PR #39, [OC](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md#oc--a-replaceable-orchestrator-and-the-checks-as-a-sub-workflow-prop-0006) |
| CQ | Worker policy, `paths` checks, the merge queue by leased push (PROP-0007, retired) | PR #42, [CQ](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md#cq--worker-policy-faster-and-clearer-checks-and-a-merge-queue-prop-0007) |
| After CQ | Profile patches merge by `ref`, fflate 0.8.3, the Host-exit backstop, reads while the Host waits to upgrade | PRs #45, #46, #59, #62 |
| W, WW | The ChatGPT Website Worker (W) and Website Workers: Runtime `web`, generic Procedures on a UI map, Power by tier, the canary, `citations-v2`, `research-fanout`; built by System Works on branch `web-workers` | PRs on branch `web-workers`, merged into `dev` 2026-11-09 at canary 94% ([PLAN.md at `6af50a7`](https://github.com/tsuuanmi/System/blob/6af50a7/PLAN.md); PROP-0005, retired) |
| DF | System develops System: Items in `STATUS.md` and `system status`, claims, tests first (`feature.yaml`: red check, tests frozen), a check the base fails too is held, one retry per failing check, `work wait` and `system mcp` across Host restarts and updates; 11 System Items merged by System Works in its last two days with no operator touch; DNA (Rust) the second repository; DF3 passed on the session takeover of 2026-11-09, whose questions became df-24, df-28 and df-31 (operator, 2026-11-10: no second run) | [DF at `ea71d80`](https://github.com/tsuuanmi/System/blob/ea71d80/PLAN.md#3-df--dogfood-decided-2026-11-08) |
| SC | Several Accounts per Runtime: Account identity and the provider's account ID (sc-1), roles `code.develop` and `code.tests` (sc-2), quota readers (sc-3), routing by Headroom under a Ceiling (sc-4), and the first remedies for outside failures (sc-7 to sc-13) | [SC in the pinned file](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md), PRs #160 to #186 |
| RO | Robust to outside failures: 10 Items in a row (ro-7 to ro-16) with no Outside failure, measured from `work report` (ro-5); routing by Headroom with no preferred Account (ro-7), `status` shows the final Artifact (ro-10), research prefers the web Runtime (ro-12), MCP across an update (ro-13); the tests step moved to Claude Code (operator, 2026-11-13). Core 3,982 lines, docs 4,283. ro-15 failed on its change and moves to SS | [RO in the pinned file](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md), PRs #196 to #212 |
| CM | Continuation and merge integrity: the Host carries waiting Works on after a restart (effects still wait for a run), three Outside failures in a row hold a step, the merge re-check is a bound verification, Item dependencies `(after: ...)` and the `statusmd` check, a human caller needs a terminal (ADR-0011), the Host never picks an Item (ADR-0012) | PRs #249 (release), Works listed in [RES-0012](docs/research/RES-0012-reuse-first-research-2026-11-14.md) in the pinned file |
| DG | First-attempt acceptance: first measure 12 of 14 Items merged by their first Work (86%), 4 System defects fixed (dg-6 to dg-9), stopped for review with dg-10 and dg-11 open (operator, 2026-11-10) | PRs #145 to #172, [DG in the pinned file](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md) |
| SS | The scheduled session: `claude -p` run by a systemd user timer with `tools/night-session.md` (6 Items or about $15 a night, writes no Items, never releases), the night report stored and sent by the launcher; canonical Workflows `develop`, `hygiene`, `research`, `brainstorm`, `code-checks`; frozen tests and the red check deleted | `168199e`, PRs #218 to #234, [SS in the pinned file](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md) |
| TR | Trust: a Task names invariants and System lists the changed tests (tr-1), research format fixes (tr-2, tr-7), failure classes (tr-3), `research-source.yaml` (tr-4), `DOC-LEN-001` at 120 characters (tr-5), the release procedure (tr-6) | release `41cbfea`, PRs #264, #268, [TR in the pinned file](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md) |
| BS | Bootstrap: `system bootstrap plan` and `check` (read-only), the zero-checks verdict is inconclusive, MCP instructions, a draft of the first checks file | PR #272, [BS in the pinned file](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md) |
| NM | Capability names: Abilities declared by Runtime adapters, Roles in the Workflows, the profile moved to the new names (2026-11-15) | [NM in the pinned file](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md) |
| FL | Flow and verification: focused tests in implement (fl-1), a context pack per Task (fl-2), the unit-test slowdown found (fl-3), attempt summaries (fl-4), `afterInstall` checks and the install verdict (fl-5, fl-6), Guardrails for Escaped defects 1, 3 and 4 (fl-8 to fl-10), the five measures (fl-11); first install Verdict passed (work:e31e50fd) | close `a96b498`, release `edb4058`, [FL in the pinned file](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md) |
| 2026-11-16/17 (RB, classes, Intent, measures) | About 40 Items, rb-1 to rb-5, lim-1, flaky-1, mcp-1, mcp-2, in-1 to in-3, cls-1 to cls-5, ms-1, ms-2, def-2, dc-1, install-1, tool-1, rsn-1 and others (STATUS.md in git history): the `upgrade` and `secrets` checks, the `docs` impact check, failure classes from structure, `flaky` and `process` causes, the Classifier component, Intents, defects and confirmations as Artifacts, the headline measure from records | `dev` merges to close commit `3ab10ae`; simplification pass in the next merge |

Who built them: PRs #5–#36 were System Works, apart from #34 and #35 (the operator's sessions); OC, CQ and the PRs after CQ
were built by the operator's sessions directly; since DF, System Works build System's own Items.

## 2. Growth and feedback budgets (Charter 11 and 12)

Record the measures at the end of every milestone. The measures of effect (Verified Success Rate, Recurring Failure Rate,
Escaped Defect Rate, Cost per Verified Work, Time to Verified Resolution) and the headline measure, verified Items merged per operator touch) come from `system work report --since <date>`, not by hand;
Escaped defects are recorded with `system defect add` (`escaped-defect@1`), and `--escaped <n>` is only an override the report labels. Growth above budget is justified in the milestone's row or paid for by removal. The core
budget is +10% per milestone from 3,403 lines ([ADR-0010](docs/decisions/ADR-0010-core-budget-rebaselined.md)); the docs
budget is 4,285 lines under `docs/`. The older columns and the reasoning behind them are in
[PLAN.md at `97a1adb`](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md#2-growth-and-feedback-budgets-charter-11-and-12).

| Measure | CM close | TR release (`41cbfea`, 2026-11-14) | FL close (`a96b498`, 2026-11-16) | 2026-11-17 close (after this pass) |
|---|---|---|---|---|
| Active core, lines | 4,183 (+7.3% on RO's 3,900, within +10%) | 4,280 (`packages/work/src` + `packages/artifacts/src`): a docs-only pass | 4,401, measured at `a052973`, which only adds documentation | 4,857 before → 4,840 after the simplification pass (one reader for the operator records, two one-use wrappers); cls-6 then took it to 4,853; 4,840 after this change (−13: comments restating code or another file's; budget ≤ 4,841) |
| All package source, lines | 14,799 | not measured | not measured | 17,098 (`packages/*/src`; 17,115 before) |
| Tests, lines | 14,853 | not measured | not measured | 22,294 (`packages/*/tests`, `tests`, `test-support`; 16 fewer: two duplicate summary tests) |
| Docs under `docs/`, lines (files) | 4,270 (42) | 4,382 (42) before, 4,284 (42) after the hygiene pass | 4,288 (42): 3 over the budget | 3,624 (35); PLAN.md 188 → 164, STATUS.md 34 |
| Required checks | about 3 min 20 s of check time (docs 1 s, install 11 s, build 32 s, typecheck 10 s, unit 43 s, smoke 92 s) | not measured | not measured | install 1 s (warm), build 33 s, typecheck 10 s, lint 14 s, unit 81 s, smoke 102 s, docs 4 s; upgrade and install-guide not run in this pass |
| Measures of effect (`system work report --since 2026-11-16T00:00:00Z`, 85 Works) | | | | Headline: 58 Items merged, 0 operator touches ("no touches"). Verified Success Rate 0.87 (71 of 82); Recurring Failure Rate 0.52 (15 of 29); Escaped Defect Rate 0.069 (4 of 58, from records); Cost per Verified Work $0.40 (5 Works of unknown cost); Time to Verified Resolution median 14.5 min (p90 49.1); tool-seconds per second 0.86 (91 attempts); 6 unknown failures |

Docs lean and tightly linked (operator, 2026-11-16): PLAN.md 657 → 166 lines; docs under `docs/` 4,162 → 3,501 lines
(ADR-0009, PROP-0004 to PROP-0007 and RES-0008 retired to [the ledger](docs/governance/retired.md)).

Measures of effect at FL's close: before FL (71 Works) Verified Success Rate 0.89, Recurring Failure Rate 0.73, Escaped
Defect Rate 0.125 (6 of 48 Items), Cost per Verified Work $0.39, Time to Verified Resolution median 10.2 min (p90 65.9);
after FL's Workflow went live (14 Works) 0.93, $0.11, median 5.1 min (p90 9.5).

**Escaped defects** are counted by hand, each with the Work that caused it and the Work that fixed it: 10 up to FL's close
(number 9 withdrawn as miscounted), one paragraph each in [PLAN.md at `97a1adb`](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md#3e-tr--trust-decided-2026-11-14);
a new one is added here as one line.

Every milestone ends with a **simplification pass**: a System Work (Sonnet) proposes deletions and simplifications (dead
code, unused abstractions, duplicated tests, docs that restate others), and the operator reviews it like any PR. The
Sonnet code review's Standards axis also checks the code against Charter items 8, 11 and 12.

## 3. Open work

Items are in [STATUS.md](STATUS.md); the sections below keep only the decisions of milestones still open. Left to the
operator (BS): the role `research.source` in the profile, so that `research-source.yaml` excludes web Accounts.

### DP — Deepening pass (decided 2026-11-18)

- **Aim:** concentrate rules that are written in several places, and that already disagree, behind deep modules that are testable through small interfaces (Charter 11 and 12). The source is the architecture review of 2026-11-18. Its seven candidates map to dp-1..dp-11.
- **Decision:** a behaviour defect gets a develop Item with a red test first. The restructuring that follows is a hygiene Item that keeps behaviour.
- **Decision:** a hygiene Item of DP does not grow the net lines of the active core (`packages/work/src` + `packages/artifacts/src`). Each records its lines before and after in its result. Growth is justified in DP's row of section 2.
- **Decision:** when STATUS.md cannot be read, `admit`, `task.new` and `item.claim` all refuse a Task, Claim or Work that names an Item, unless `force` is set (dp-2). A Work without an Item is not affected.
- **Decision:** the pinned-verifier version check stays an `error` refusal in the controller and a `hold` in the merge check. This is deliberate: a merge awaits an Approval.
- **Decision:** no new GLOSSARY terms. "Item gate" and "Verification" are module names. Do not use "judge" (GLOSSARY lists it under Avoid for Classifier).
- **Decision:** DP runs now, with the operator present, in parallel where Items do not depend on each other. The scheduled session does not take dp-8, dp-9, dp-10 or dp-11.
- **ADR fit:** ADR-0002 (one generic interpreter: do not split the controller per domain), ADR-0003, ADR-0007 and ADR-0012 (Item state derived, the Host never picks).
- **Order:** by `after:`. The first parallel wave is dp-1, dp-2, dp-4, dp-5 and dp-10.

### RB — Release boundary (decided 2026-11-16)

- Aim: no defect of the kind "old release meets new release" reaches production or blocks the pipeline. Its finished decisions are in section 0.
- Open decisions:
  - The unattended-scale spike (isolation in section 0) comes after the Items still open in STATUS.md (operator, 2026-11-17).
  - The Classifier stays report-only until it passes cls-2's gate on labelled data; contracts are JSON Schema, and Jev is not adopted now (section 4).
  - Left to the operator (BS): the role `research.source` in the profile.
  - Decision (2026-11-18): the Classifier stays off and report-only after two real evaluations failed the gate (hybrid 63.4% both times; report Artifacts sha256:4613d1ee… and sha256:74e1452b…). Operator decision (2026-11-18): keep the code, off; re-evaluate when the labelled set has grown past 80 failures, and delete packages/classifier then if the gate still fails (Charter 9).
- Order (priority, not dependency): the Items still open in STATUS.md, then the unattended-scale spike.


### ROI review (2026-11-16; Items ns-1, ns-2, ns-3)

- Ranking: turn on the scheduled session; ns-2 Guardrail; ns-1 DNA; ns-3.
- Decisions (operator, 2026-11-16):
  - The scheduled session runs with SS's limits (6 Items a night, Ready `todo` only, no approve, no release) for System now and DNA after ns-1.
  - Unattended-scale isolation (bubblewrap, ADR-0011) is required before raising those limits or adding more repositories, not before turning the session on.
  - pstack's trial and the attempt-summary accuracy work are deferred until data asks for them.
- Facts: the timer had never been installed (installed by the operator on 2026-11-16 per the runbook); System and DNA had no `todo` Items, so the session's value depends on a queue of Ready Items written by the operator or a caller session.

## 4. Future, not current gates

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
- [ ] Select tests by the import graph of the changed files (Jest `--findRelatedTests`, Vitest `related`, Nx affected
  are the standards; Node's test runner has none). *Trigger: the required checks exceed their time budget (Charter 12).
  Risk: the smoke tests boot the Host through `bin/system` and load plugins dynamically, so an import graph misses
  dependencies.*
- [ ] A check-run planner inside the required-checks Verifier (`packages/verifiers/src/checks.ts` `verify` holds three strategies in one closure): the plan of what runs where, separated from the worktree and spawner that execute it. *Trigger: `verifiers.test.ts` blocks a change, after dp-6 has taken its "flaky" rule.*
- [ ] Adaptive routing only on a measured need, such as quota exhaustion.
- [ ] A fixed set of reproducible failure scenarios to compare System versions. *Trigger: a change to a retry or
  recovery rule that needs a before/after comparison the Host's records cannot give.*
- [ ] A model review step in a separate optional Workflow. *Trigger: an Escaped defect that a review of the diff would
  have caught; the last ones sat on the release boundary, which RB addresses.*
- [ ] Website Worker: a repair turn in the same chat when the model leaves out an output block (about 6%; proposed as
  WW6m, not decided); a long-lived Chrome per Account; a second Site; `digest`. *Trigger: measurement asks for it.*
- [ ] The verifier's timeout and leftover-process handling on Ubuntu 26.04: a timed-out check reports exit 137, and
  three tests in `packages/verifiers/tests/verifiers.test.ts` fail there (a check over its timeout, a check that leaves
  an Xvfb or Chrome behind, a timed-out check names the test that was running). CI is pinned to `ubuntu-24.04` until
  then. *Trigger: install-1, or an operator machine on 26.04.*
- [ ] Jev (TypeSafe AI) or another hosted decision model as a Classifier backend. *Trigger: the economy-model
  Classifier fails cls-2's gate; before any trial, its data retention terms are confirmed (the research found them
  inconsistent) and the report's citations verified.*
