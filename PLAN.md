# PLAN.md — System: finished milestones, open work and the standing decisions

> **Status:** updated 2026-11-27. Open work is the Items of [STATUS.md](STATUS.md) (state derived by `system status`)
> and section 3 below. Each finished milestone is one line in section 1; its checklist, evidence and decisions as
> written then are in [PLAN.md at `97a1adb`](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md) (sections 3 to 3h), and for the older ones in
> [PLAN.md at `aaa38f6`](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md). The closed records of sections 2 to 4 (FL-close history, DP and RC close, the dated log of 2026-11-19/20 and the review records) as they stood on 2026-11-27 are in
> [PLAN.md at `4f6cb24`](https://github.com/tsuuanmi/System/blob/4f6cb243f59581379e1e3babd8cd38708531dd81/PLAN.md). This file is not an ADR or an alternate source of product requirements.

## 0. Read and align

- [Product Charter](docs/requirements/purpose.md) (which holds the MVP scope), [accepted ADRs](docs/decisions/README.md)
  and [GLOSSARY.md](GLOSSARY.md) define product and architecture truth. Recheck the current state before changing code.
- **Deferred MVP-1 items** (operator, 2026-11-08): sandbox, egress denial, and a plugin unload with Work in flight
  (MVP failure tests 3 and 4) wait for a Worker that runs untrusted code or content. Judged not met (2026-11-16):
  Workers run only the operator's own repositories with lockfile-pinned dependencies; rb-5's secret scan and rb-4's
  permission-flag tests come before a sandbox. Operator, 2026-11-18: the trigger is met for a spike (sb-1, section 3):
  a dry-run push from an attempt's environment authenticated with the operator's SSH key, and Workers read web pages.

**Standing decisions of finished milestones** (each has this one home; the reasoning is in the pinned file):

- Only a human verifies again, approves or denies; operator touches go down through bounded, declared automatic
  re-runs, never by giving an agent that authority (RO, operator, 2026-11-11). A load gate on the checks waits for a measure.
- A Claim never expires and `force` is the only takeover; stall means no timeout that aborts; Item dependencies are
  `(after: ...)`, a DAG within one repository; three Outside failures in a row on a step hold the Work; a changed
  verifier or an inconclusive verdict on the merge commit needs an Approval of that commit; the human/agent boundary is
  advisory within one OS user ([ADR-0011](docs/decisions/ADR-0011-human-caller-needs-a-terminal.md)) (CM, 2026-11-14).
- ROI of an Item is what it improves in later Items (Items merged on their first Work, cost per merged Item, operator
  minutes per Item, Escaped defects) over its own cost and operator minutes. Invariants are prose in a Task and the
  changed tests are disclosed, never frozen tests or a model review (model review: see ADR-0013). Order after TR: bootstrap, then unattended scale (TR, 2026-11-14).
- Bootstrap is read-only first (`plan`, `check`; `apply` waits); the first checks file is a draft a human commits,
  because admission refuses a Work without one; several repositories on one Host are accepted under today's limits:
  GitHub `origin`, `dev`, one token (BS, overnight session 2026-11-15, the operator may change them).
- Capabilities are an Ability (declared by the Runtime adapter), a Role (`<workflow>.<part>`, granted in the profile)
  or a Tier (`tier.*`); a rename is expand, then contract; the citation verifier stays as strict as it is (NM, 2026-11-15).
- A `checks.yaml` key or verifier version is pinned a release after the one that added it, because the running Host
  refuses what it does not know (Q0, Escaped defects 3 and 7; [verifiers README](packages/verifiers/README.md)).
- Unattended-scale isolation: bubblewrap, the same OS user (the shared server gives no root), `$HOME` hidden with an
  allow-list, a per-attempt clone with read-only alternates, network kept, CLI Workers and the Scheduled session
  (2026-11-15; decided as
  [ADR-0016](docs/decisions/ADR-0016-the-gate-is-enforced-by-reachability.md) on 2026-11-27).
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
| CM | Continuation and merge integrity: the Host carries waiting Works on after a restart (effects still wait for a run), three Outside failures in a row hold a step, the merge re-check is a bound verification, Item dependencies `(after: ...)` and the `statusmd` check, a human caller needs a terminal (ADR-0011), the Host never picks an Item (ADR-0012) | PRs #249 (release), Works listed in [RES-0012](docs/governance/retired.md) in the pinned file |
| DG | First-attempt acceptance: first measure 12 of 14 Items merged by their first Work (86%), 4 System defects fixed (dg-6 to dg-9), stopped for review with dg-10 and dg-11 open (operator, 2026-11-10) | PRs #145 to #172, [DG in the pinned file](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md) |
| SS | The scheduled session: `claude -p` run by a systemd user timer with `tools/night-session.md` (6 Items or about $15 a night, writes no Items, never releases), the night report stored and sent by the launcher; canonical Workflows `develop`, `hygiene`, `research`, `brainstorm`, `code-checks`; frozen tests and the red check deleted | `168199e`, PRs #218 to #234, [SS in the pinned file](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md) |
| TR | Trust: a Task names invariants and System lists the changed tests (tr-1), research format fixes (tr-2, tr-7), failure classes (tr-3), `research-source.yaml` (tr-4), `DOC-LEN-001` at 120 characters (tr-5), the release procedure (tr-6) | release `41cbfea`, PRs #264, #268, [TR in the pinned file](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md) |
| BS | Bootstrap: `system bootstrap plan` and `check` (read-only), the zero-checks verdict is inconclusive, MCP instructions, a draft of the first checks file | PR #272, [BS in the pinned file](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md) |
| NM | Capability names: Abilities declared by Runtime adapters, Roles in the Workflows, the profile moved to the new names (2026-11-15) | [NM in the pinned file](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md) |
| FL | Flow and verification: focused tests in implement (fl-1), a context pack per Task (fl-2), the unit-test slowdown found (fl-3), attempt summaries (fl-4), `afterInstall` checks and the install verdict (fl-5, fl-6), Guardrails for Escaped defects 1, 3 and 4 (fl-8 to fl-10), the five measures (fl-11); first install Verdict passed (work:e31e50fd) | close `a96b498`, release `edb4058`, [FL in the pinned file](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md) |
| 2026-11-16/17 (RB, classes, Intent, measures) | About 40 Items, rb-1 to rb-5, lim-1, flaky-1, mcp-1, mcp-2, in-1 to in-3, cls-1 to cls-5, ms-1, ms-2, def-2, dc-1, install-1, tool-1, rsn-1 and others (STATUS.md in git history): the `upgrade` and `secrets` checks, the `docs` impact check, failure classes from structure, `flaky` and `process` causes, the Classifier component, Intents, defects and confirmations as Artifacts, the headline measure from records | `dev` merges to close commit `3ab10ae`; simplification pass in the next merge |
| DP, RC (2026-11-18) | Deep modules: Host client, Item gate, Verification, structured failure causes, `WorkState` facts, next-move, Account admission, one attempt lifecycle, Runtime adapters; `controller.ts` 1,322 → 1,031 lines; dp-1..dp-12. Root causes of recurring failures: rp-1, flaky-2, rc-1, rc-2, rc-3, and the time-dependent intent test fix in work:5fd0b709 | release PR #411 (b98e992) |

Who built them: PRs #5–#36 were System Works, apart from #34 and #35 (the operator's sessions); OC, CQ and the PRs after CQ
were built by the operator's sessions directly; since DF, System Works build System's own Items.

## 2. Growth and feedback budgets (Charter 11 and 12)

Record the measures at the end of every milestone. The measures of effect (Verified Success Rate, Recurring Failure Rate,
Escaped Defect Rate, Cost per Verified Work, Time to Verified Resolution) and the headline measure (verified Items merged per operator touch) come from `system work report --since <date>`, not by hand;
Escaped defects are recorded with `system defect add` (`escaped-defect@1`), and `--escaped <n>` is only an override the report labels. The active core's lines and the docs' are a trend recorded here at each milestone, never a gate ([ADR-0015](docs/decisions/ADR-0015-changeability-is-measured-not-budgeted.md)); `work report --since` shows the core's lines at the range's start and end. Older columns: [PLAN.md at `97a1adb`](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md#2-growth-and-feedback-budgets-charter-11-and-12); the FL-close columns and paragraphs: [PLAN.md at `4f6cb24`](https://github.com/tsuuanmi/System/blob/4f6cb243f59581379e1e3babd8cd38708531dd81/PLAN.md).

| Measure (trend) | DP close (2026-11-18) | 2026-11-27 (counted from the tree at `4f6cb24`) |
|---|---|---|
| Active core, lines (`.ts` of `packages/work/src` and `packages/artifacts/src`) | 5,117 (4,840 before DP) | 5,639 |
| All package source, lines (`packages/*/src` `.ts`) | 17,098 (2026-11-17) | 19,303 |
| Docs under `docs/`, lines (files) | 3,624 (35) (2026-11-17) | 5,058 (52) |

**Escaped defects** are counted from records (`system defect add`); the 10 counted by hand up to FL's close: [PLAN.md at `97a1adb`](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md#3e-tr--trust-decided-2026-11-14).

Every milestone ends with a **simplification pass**: a System Work (Sonnet) proposes deletions and simplifications (dead
code, unused abstractions, duplicated tests, docs that restate others), and the operator reviews it like any PR. The
Sonnet code review's Standards axis also checks the code against Charter items 8, 11 and 12.
A milestone closes only when every failure class that recurred 3 or more times in its range (`system work report --since <milestone start>`, `recurringClasses`) has a root-cause Item or a recorded reason in the milestone's section (rc-1).

Checks per Work (RES-0018, Item chk-reuse-1): before reuse, 2026-11-26 (29 merged Works), median 3.7 min and p90 14.3 min. After: not yet measured; reuse applies only
where a pass with byte-identical inputs exists (a retry of a reopened step, a Work on a base already checked), so the after figure is taken with
`system work report` over the Works merged since this Item and recorded here with the Work count, next to the before.

Checks run in parallel (Item chk-par-1, 2026-11-27): measured, not adopted. Typecheck, lint, unit and smoke write nothing into the worktree and together took 53 s against 121 s in sequence, but the leak sweep keyed by the one `HOME` and the load on a Host that runs checks of two Works at once block it (reasons in [packages/verifiers/README.md](packages/verifiers/README.md)). Checks per Work are unchanged by this Item: median 3.7 min, p90 14.3 min (the before of chk-reuse-1).

## 3. Open work

Items are in [STATUS.md](STATUS.md); this section keeps only the decisions that still bind. Left to the operator (BS):
the role `research.source` in the profile, so that `research-source.yaml` excludes web Accounts. Closed records (DP and
RC's close review and measures, the ROI review, EV's and RB's review records, ID's sources, the sb-1, DNA-intent, IR and
CT log) are in [PLAN.md at `4f6cb24`](https://github.com/tsuuanmi/System/blob/4f6cb243f59581379e1e3babd8cd38708531dd81/PLAN.md).

- **DP and RC:** a defect is a develop Item with a red test, and a restructuring is behaviour-keeping. The pinned-verifier
  `error` in the controller and `hold` in the merge check is deliberate: a merge awaits an Approval. No "judge" term.
- **EV (operator, 2026-11-18):** "reliable" means an evening's Works reach a correct terminal state with no operator
  present and nothing merges that its checks did not pass, judged by the existing measures; model judgement does not
  move into the Host (ADR-0012). A caller may submit Works that write nothing to a repository (research,
  research-source, brainstorm, plan-items) without asking, at most 8 a round; a review round with fewer than 3 accepted
  Items ends the self-improvement. Sandbox: ADR-0016's layer; it replaces
  Claude Code's own (sb-1). Reading Item state back from git waits for a second machine or a restore.
  research.yaml keeps `prefer: web.browse`. One release per accepted batch.

### ID — Identity (decided 2026-11-21)

- A product Batch records the product's own measure before and after it; System records the number and owns neither
  the evaluation set nor the error budget. Operator acts stay the headline's unit.
- An Item for System is opened only when a product Batch's records point at it, when it repairs a promised safety
  guarantee, or when it deletes something unused.
- One caller session at a time writes Items and submits Works for a repository (from 2026-11-21).
- Roles by fit: Claude Code implements; Codex is tried on work that does not write to a repository, by configuration
  only; a Codex adapter for web research is an Item only if that is useful.
- The caller session carries DNA's supply loop (evidence, `plan-items`, one Intent, the scheduled session, one release).
  The error budget, adjudication, re-baselining, approvals and releases stay the operator's; the full T2 evaluation
  runs at night or at a release, not per Work; held-out batches are never read by a Work.
- Release delegated (operator, 2026-11-26): to a caller session on conditions: the release pull request's CI passes and
  `system update`'s release check and install check pass; any failure stops the release, records an Escaped defect and
  is fixed through a Work. Never approve, deny or verify again. A caller's release is not an operator act (ms-4).
  Not delegated (operator, 2026-11-27): a release that touches `packages/verifiers/src`, `packages/effects/src` or
  `workflows/*.yaml`, because those take effect only at a release; a caller's release that touched them is reported as
  a violation (relgate-1) and recorded as an Escaped defect.
- No Item caps (operator, 2026-11-26): the scheduled session and a `/goal` session take every Ready `todo` Item; each
  Item is still one Worker attempt with a test that fails first, and the Operator settles the Intent behind it.
- Reopened by: Items per operator act on product Batches staying under 3.6 after three Batches; DNA Batches whose
  operator minutes are mostly running the loop; ADR-0016's layer failing in a way configuration cannot fix;
  late-caught or escaped defects rising under ADR-0014's tiers.

### RB and later decisions

- RB: the unattended-scale spike (isolation in section 0) comes after the Items still open in STATUS.md. The
  Classifier stays off and report-only after two evaluations failed cls-2's gate (63.4%); keep the code, off;
  re-evaluate past 80 labelled failures and delete packages/classifier then if the gate still fails (Charter 9).
  Contracts are JSON Schema; Jev is not adopted now (section 4).
- IR (2026-11-20): batches 2 and 3 (context-pack and file-overlap warnings, `guardrail.yaml`, a Model check of Done
  when, Triage in shadow, a doc-truth Model check) open only when `recurringClasses` on DNA's Works ask for them;
  rerunning a check stays the operator's (RO). CT: checks in tiers by event, [ADR-0014](docs/decisions/ADR-0014-checks-in-tiers-by-event.md).
- The gate holds unattended (operator, 2026-11-27; Intent 21e4cf418770, ADR-0016; Items gate-2, iso-1 to iso-3,
  relgate-1, cost-1). The ID rule for opening a System Item stands. Removing the Item cap on 2026-11-26 waived the
  2026-11-16 condition that isolation comes before raising the Scheduled session's limits; adding repositories still
  waits for iso-1 to iso-3 released. This repository's Gate paths are `.system/checks.yaml` and `.github/workflows/**`.
  The operator's own: required status checks `build` and `docs` on `main`; one Account with `sandbox` on for one night,
  then the decision on default on. The `unknown` failure class gets no Item: 66 of its 69 since 2026-11-01 came before
  2026-11-20 (rc-1 catches a recurrence), and Satisfied keeps needing a test a Verifier ran.

## 4. Future, not current gates

- [ ] Research quality capabilities (source snapshots, citation consistency, claim-to-evidence checking) as separately
      selected verifiers, and source fetching with content identity (the Website Worker's layer 2). *Trigger: a Research
      Work whose accepted report the operator finds wrong because a source changed or a claim was not supported. Until
      then, V1's ratio policy (unconfirmed quotes are listed, not hidden) is the bar (2026-11-06).*
- [ ] Optional Skill, LSP, web-fetch or another Worker adapter only if a Work fails for want of one and the pinned DSH
      plugin can satisfy the System contract without duplicating the model loop.
- [ ] Select tests by the import graph of the changed files (Jest `--findRelatedTests`, Vitest `related`, Nx affected).
      *Trigger: the required checks exceed their time budget (Charter 12). Risk: the smoke tests boot the Host through
      `bin/system` and load plugins dynamically, so an import graph misses dependencies.*
- [ ] A check-run planner inside the required-checks Verifier (`packages/verifiers/src/checks.ts` `verify` holds three
      strategies in one closure). *Trigger: `verifiers.test.ts` blocks a change, after dp-6 has taken its "flaky" rule.*
- [ ] Adaptive routing only on a measured need, such as quota exhaustion.
- [ ] A fixed set of reproducible failure scenarios to compare System versions. *Trigger: a change to a retry or
      recovery rule that needs a before/after comparison the Host's records cannot give.*
- [ ] A model review step in a separate optional Workflow. *Trigger: an Escaped defect that a review of the diff would
      have caught; the last ones sat on the release boundary, which RB addresses.*
- [ ] Website Worker: a repair turn in the same chat when the model leaves out an output block (about 6%; WW6m, not
      decided); a long-lived Chrome per Account; a second Site; `digest`. *Trigger: measurement asks for it.*
- [ ] The verifier's timeout and leftover-process handling on Ubuntu 26.04: a timed-out check reports exit 137, and three
      tests in `packages/verifiers/tests/verifiers.test.ts` fail there. CI is pinned to `ubuntu-24.04` until then.
      *Trigger: install-1, or an operator machine on 26.04.*
- [ ] Jev (TypeSafe AI) or another hosted decision model as a Classifier backend. *Trigger: the economy-model Classifier
      fails cls-2's gate; first confirm its data retention terms and verify the report's citations.*
