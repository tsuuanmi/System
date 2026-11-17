# PLAN.md — System: finished milestones, open work and the standing decisions

> **Status:** updated 2026-11-16. Open work is the Items of [STATUS.md](STATUS.md) (state derived by `system status`)
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

Who built them: PRs #5–#36 were System Works, apart from #34 and #35 (the operator's sessions); OC, CQ and the PRs after CQ
were built by the operator's sessions directly; since DF, System Works build System's own Items.

## 2. Growth and feedback budgets (Charter 11 and 12)

Record the measures at the end of every milestone. The measures of effect (Verified Success Rate, Recurring Failure Rate,
Escaped Defect Rate, Cost per Verified Work, Time to Verified Resolution) come from `system work report --since <date>
[--escaped <n>]`, not by hand. Growth above budget is justified in the milestone's row or paid for by removal. The core
budget is +10% per milestone from 3,403 lines ([ADR-0010](docs/decisions/ADR-0010-core-budget-rebaselined.md)); the docs
budget is 4,285 lines under `docs/`. The older columns and the reasoning behind them are in
[PLAN.md at `97a1adb`](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md#2-growth-and-feedback-budgets-charter-11-and-12).

| Measure | CM close | TR release (`41cbfea`, 2026-11-14) | FL close (`a96b498`, 2026-11-16) |
|---|---|---|---|
| Active core, lines | 4,183 (+7.3% on RO's 3,900, within +10%) | 4,280 (`packages/work/src` + `packages/artifacts/src`): a docs-only pass | 4,401, measured at `a052973`, which only adds documentation |
| All package source, lines | 14,799 | not measured | not measured |
| Tests, lines | 14,853 | not measured | not measured |
| Docs under `docs/`, lines (files) | 4,270 (42) | 4,382 (42) before, 4,284 (42) after the hygiene pass | 4,288 (42): 3 over the budget |
| Required checks | about 3 min 20 s of check time (docs 1 s, install 11 s, build 32 s, typecheck 10 s, unit 43 s, smoke 92 s) | not measured | not measured |

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

### RB — Release boundary (decided 2026-11-16)

- Aim: no defect of the kind "old release meets new release" reaches production or blocks the pipeline.
- Evidence: Escaped defects 3, 7 and 8, and fl-6's install assumptions, all sit on the boundary between the previous release and the new one; the operator's emergency commit `b2d4e0d` reached `dev` without checks and left a failing test.
- Decisions (operator, 2026-11-16):
  - A rehearsal check (`upgrade`, rb-1) runs the update from `main` to the commit under check, path-limited to keep checks fast.
  - A standard git `pre-push` hook (rb-2) covers hand pushes; System's own publish is not affected.
  - TR's close criterion is kept as it is; RB is its path.
  - Grilling of the "Verified Feedback Loop v2" proposal (operator, 2026-11-16): no new milestone; rb-3, rb-4 and rb-5
    are added after rb-2; no new measures, no confidence in failure classes, no recovery-decision component in the
    core (a new recovery rule is a Workflow declaration); a Task's Done when stays guidance and only a Verifier's
    criteria gate. Evidence:
    - Recurring Failure Rate counts a failure as recurring when its coarse class (an Outside cause, or `change-<kind>`:
      about ten classes) appeared in an earlier Work of the range (packages/work/src/measures.ts). In the FL window
      (from 2026-11-15 13:40 UTC: 39 Works, 6 failures) it reads 3/6 = 0.50; keyed by the same check and the same
      first failing test it reads 0/6 within the window, 1/6 with earlier history (verifiers.test.ts "System's own
      checks..." on 2026-11-14 and 2026-11-16).
    - outsideCause (packages/work/src/outside.ts) matches its patterns against the whole reason, test names included:
      work:b131dd34 (smoke test "work wait survives a Host restart" timed out) is counted `restart`, and work:c6e7cba1
      (a failure in workers-quota.test.ts) is counted `quota`. Report only: cm-2's hold count reads `limited` and
      `attempt-lost`, not verdict reasons.
    - Of the proposal's eight Verification Contract invariants, tests pin four (pinned verdict criteria and version;
      bounded retry.onFail with the previous evidence; base re-run gives inconclusive; unknown effect outcome is
      reconciled, never retried blindly), three partly (the controller's `'stale'` branch is never reached by a test;
      a verifier that throws has no test, in the controller or the merge check; no test has a late `observed` of a
      lost attempt on a live Host), and one not at all (no test asserts the Claude Code allow/deny flags or the Codex
      sandbox flag in packages/agents/src/runtimes.ts; nothing scans a change for secrets).
  - Second grilling (operator, 2026-11-16): System's purpose and headline measure are in the Charter (6a1a31c); unused parts deleted (8018e2d); Intent becomes an Artifact (in-1, in-2, in-3); lim-1 and flaky-1 come first because each failed a Work today; mcp-1 because sessions see "Host not running" after every Host restart.
- Order: lim-1, flaky-1, ns-2, mcp-1, in-1, in-2, rb-3, rb-4, rb-5, install-1, in-3, then the unattended-scale spike (operator, 2026-11-16).


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
