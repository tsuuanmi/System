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
  Operator, 2026-11-18: the trigger is met for a spike (section 3, EV): a dry-run push from an attempt's environment
  authenticated with the operator's SSH key, and Workers read web pages.

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
| DP, RC (2026-11-18) | Deep modules: Host client, Item gate, Verification, structured failure causes, `WorkState` facts, next-move, Account admission, one attempt lifecycle, Runtime adapters; `controller.ts` 1,322 → 1,031 lines; dp-1..dp-12. Root causes of recurring failures: rp-1, flaky-2, rc-1, rc-2, rc-3, and the time-dependent intent test fix in work:5fd0b709 | release PR #411 (b98e992) |

Who built them: PRs #5–#36 were System Works, apart from #34 and #35 (the operator's sessions); OC, CQ and the PRs after CQ
were built by the operator's sessions directly; since DF, System Works build System's own Items.

## 2. Growth and feedback budgets (Charter 11 and 12)

Record the measures at the end of every milestone. The measures of effect (Verified Success Rate, Recurring Failure Rate,
Escaped Defect Rate, Cost per Verified Work, Time to Verified Resolution) and the headline measure, verified Items merged per operator touch) come from `system work report --since <date>`, not by hand;
Escaped defects are recorded with `system defect add` (`escaped-defect@1`), and `--escaped <n>` is only an override the report labels. The active core's lines and the docs' are a trend recorded here at each milestone, never a gate ([ADR-0015](docs/decisions/ADR-0015-changeability-is-measured-not-budgeted.md)); `work report --since` shows the core's lines at the range's start and end. The older columns and the reasoning behind them are in
[PLAN.md at `97a1adb`](https://github.com/tsuuanmi/System/blob/97a1adb2756e31eed15434fb9916b83dd2fa7255/PLAN.md#2-growth-and-feedback-budgets-charter-11-and-12).

core +71: ir-4 fresh dev: fetch before status and task.new

| Measure | CM close | TR release (`41cbfea`, 2026-11-14) | FL close (`a96b498`, 2026-11-16) | 2026-11-17 close (after this pass) | DP close (2026-11-18) |
|---|---|---|---|---|---|
| Active core, lines | 4,183 (+7.3% on RO's 3,900, within +10%) | 4,280 (`packages/work/src` + `packages/artifacts/src`): a docs-only pass | 4,401, measured at `a052973`, which only adds documentation | 4,857 before → 4,840 after the simplification pass (one reader for the operator records, two one-use wrappers); cls-6 then took it to 4,853; 4,840 after this change (−13: comments restating code or another file's; budget ≤ 4,841) | 4,840 before → 5,117 at the peak (new modules first, the code they replace later) → 5,117 after dp-12 (unused imports only, 0 lines): over the 4,841 budget by 276. The remainder stays because a re-read of every core file found no code the DP modules left behind: each `events` scan that remains (`next-move.ts`, `verification.ts`, `status.ts`, `host.ts`) reads facts `WorkState` does not hold, and the one-use helpers left are named steps whose inlining would only lengthen the function that calls them. Going lower would harm clarity; the budget is revisited when an Item deletes a feature, not a helper. |
| All package source, lines | 14,799 | not measured | not measured | 17,098 (`packages/*/src`; 17,115 before) | not re-measured |
| Tests, lines | 14,853 | not measured | not measured | 22,294 (`packages/*/tests`, `tests`, `test-support`; 16 fewer: two duplicate summary tests) | not re-measured |
| Docs under `docs/`, lines (files) | 4,270 (42) | 4,382 (42) before, 4,284 (42) after the hygiene pass | 4,288 (42): 3 over the budget | 3,624 (35); PLAN.md 188 → 164, STATUS.md 34 | not re-measured |
| Required checks | about 3 min 20 s of check time (docs 1 s, install 11 s, build 32 s, typecheck 10 s, unit 43 s, smoke 92 s) | not measured | not measured | install 1 s (warm), build 33 s, typecheck 10 s, lint 14 s, unit 81 s, smoke 102 s, docs 4 s; upgrade and install-guide not run in this pass | not re-measured |
| Measures of effect (`system work report --since 2026-11-16T00:00:00Z`, 85 Works) | | | | Headline: 58 Items merged, 0 operator touches ("no touches"). Verified Success Rate 0.87 (71 of 82); Recurring Failure Rate 0.52 (15 of 29); Escaped Defect Rate 0.069 (4 of 58, from records); Cost per Verified Work $0.40 (5 Works of unknown cost); Time to Verified Resolution median 14.5 min (p90 49.1); tool-seconds per second 0.86 (91 attempts); 6 unknown failures | `system work report --since 2026-11-17T21:00:00Z`, 26 Works: 20 Items merged; 5 operator acts (4 Items per act); Verified Success Rate 0.88 (22 of 25); Recurring Failure Rate 0.53 (8 of 15); 0 escaped defects; Cost per Verified Work $0.66; Time to Verified Resolution median 16.8 min (p90 42) |

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
A milestone closes only when every failure class that recurred 3 or more times in its range (`system work report --since <milestone start>`, `recurringClasses`) has a root-cause Item or a recorded reason in the milestone's section (rc-1).

## 3. Open work

Items are in [STATUS.md](STATUS.md); the sections below keep only the decisions of milestones still open. Left to the
operator (BS): the role `research.source` in the profile, so that `research-source.yaml` excludes web Accounts.

### DP and RC — closed 2026-11-18

- **Decisions in force:** a defect is a develop Item with a red test, and a restructuring is behaviour-keeping. The pinned-verifier `error` in the controller and `hold` in the merge check is deliberate: a merge awaits an Approval. No "judge" term. Callers split Items by Done when.
- **rc-1 close review (classes recurring 3 or more times):** `change:docs:` 7: root-cause Item rc-3; the implement step now runs the cheap docs checks, live from release b98e992, and every occurrence in the range came before that release. `conflict` 3: root-cause Item rp-1; a reopened step now keeps the passed change, and the conflicts themselves are Outside failures of parallel Works on hot files, which DP made smaller. `load` (2) is under the threshold.
- **Measures at close:** 20 Items merged; 5 operator acts (3 Intents settled, 2 releases), 4 Items per act; Verified Success Rate 0.88 (22 of 25); Recurring Failure Rate 0.53 (8 of 15); 0 escaped defects in range; Cost per Verified Work $0.66; Time to Verified Resolution median 16.8 min (p90 42 min).

### EV — Evolution review (decided 2026-11-18)

- Records (file Artifacts; each lists its Works and report Artifacts): cycle 1
  sha256:30fe596df98cf88e636ec83b9bf1467b7c724f30d90432d96f87577493b4c05a, round 2
  sha256:8fcf3b5dd382a0f32dada2a197195357ea564d3a57f2b68d613df8de7a8c28a1. Items: web-5 and ms-3 (intent c24b484b860f);
  flaky-3, auth-1, sat-1, store-1 and git-1 (intent 2c5c9b5c979d).
- Decisions (operator, 2026-11-18):
  - "Reliable" means an evening's Works reach a correct terminal state with no operator present and nothing merges that
    its checks did not pass; it is judged by the existing measures. Model judgement does not move into the Host
    (ADR-0012 stands).
  - A caller may submit Works that write nothing to a repository (research, research-source, brainstorm, plan-items)
    without asking, at most 8 a round. New Items are accepted in batches of at most 6. A review round that yields fewer
    than 3 accepted Items ends the self-improvement, and work turns to product Intents.
  - Sandbox: research into Claude Code's own sandbox first, then one spike Item. The operator protects `main` on GitHub.
  - Reading Item state back from git waits for a second machine or a restore; git-1 only records the Item in the commit.
  - research.yaml keeps `prefer: web.browse`; a caller pins a large question to a CLI Account with `worker`; reviewed
    after 20 research Works from the release that carries web-5.
  - One release per accepted batch.
- Not built, each with its reason in the records: a merge-queue change (it would save 62 of 549 publish minutes), a
  redesign of the documentation rule (rc-2, rc-3 and rp-1 are measured first), carrying on a lost verifier after a Host
  kill (no occurrence in 768 Works), a fixed evaluation set (it shows only differences of about 20 points).
- Open measurements: E1 to E4 of the cycle-1 record.

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
- Batch 2 merged on the first Work of each Item (flaky-3, auth-1, git-1, sat-1, store-1; record: file Artifact
  sha256:0fe9f86c7ad91a2ac3dd6550b74ada812a438a471327e5bf8099c9f89395c0d0, which also holds the sandbox research and
  probe). Release 6baf5f2 (pull request #423) carries both batches; its install check is work:448ecf91.
- Operator, 2026-11-19: for this batch the caller session protected `main` on GitHub (a pull request is required,
  administrators included, no force push, no deletion), opened and merged the release pull request and ran
  `system update`, on the operator's instruction in that session. This is not a standing permission: a Release stays
  the operator's.
- Measured after the release: `system work report --since 2026-11-10T00:00:00Z` reads 40 releases and 3.58 Items per
  operator act (80 and 2.10 before ms-3); `system doctor --store` on the operator's home is ok (786 Works, 10,969
  Artifacts, 1,969 blobs, 142 MB read in 4.4 s).
- Operator, 2026-11-19: the active core grew from 5,126 to 5,191 lines in this review (releases.ts, controller.ts,
  artifacts.ts, index.ts) and is recorded in section 2 at the next close; from now on a context pack says that the
  active core does not grow, or that the result gives the lines and why. Next: sb-1 (intent 5f27ce2334c1), a spike of
  Claude Code's own sandbox, off by default.
- sb-1 merged on its first Work (work:0363e8eb, commit 9d7a153, not released): the Account option `sandbox` of the
  Claude Code Runtime builds the settings in packages/agents/src/adapters/sandbox.ts (deny the passwd home; allow the
  attempt's directories, the repository's git directory and the toolchain on PATH; `failIfUnavailable`; no
  unsandboxed command). No Account has it on. The active core stayed at 5,191 lines.
- Open for the operator (sb-1): Claude Code documents no way to leave Bash's network open under its sandbox, so with
  the option on Bash reaches only the hosts in the option's `allowedDomains` (none by default; WebFetch and WebSearch
  are outside the sandbox). The Intent 5f27ce2334c1 said the network stays as it is: turning the option on for an
  Account therefore needs the operator's decision on the hosts (a changed Intent is a new Intent).
- Not verified (sb-1): the gated test "Claude Code under the sandbox option cannot read the real home or write outside
  the worktree, and can still commit and run node --test" (tests/real-agents.test.ts) needs `SYSTEM_REAL_AGENTS=1` and
  the Account's token in `CLAUDE_CODE_OAUTH_TOKEN`, which a caller session does not hold; nobody has run it. What a
  throwaway HOME does to the sandbox's paths and whether `corepack pnpm install` works under it are undetermined
  until it runs.
- Operator, 2026-11-19: the review of System itself ends here (8 Items for 4 operator acts, 2.0 Items per act against
  4.25 before; two nights in a row the scheduled session found no `todo` Item). The next return is sought in the
  product DNA through System. ROI stays as section 0 defines it, with the product's own measure counted. Record: file
  Artifact sha256:5b8c7fb8da223989d3919069eac14232cdff192d186ac08909af1c64ef83da41 (Brainstorm work:60d6e265).
- DNA Intent 432602283824 (settled by the operator in the DNA session, 2026-11-19; it supersedes 8f320a604aa5, which
  made the full T2 evaluation the check): a green base (chrono replaced by jiff, `deny.toml` unchanged, Item deps-2);
  DNA's existing regression gate (`tools/gates.sh regress`, 589 samples, about 20 s) as the per-change check of DNA's
  `.system/checks.yaml`, with a chain of intents (one intent file per output-changing Item, named by its Item id) that
  the operator records once at the release; the full T2 evaluation at night or at a release, not per Work (a run took
  970 s with a cold cache, twice per Work, and a raw-count rule would have failed a correct change); then one batch of
  at most 6 product Items run by the scheduled session and released once, with the operator's minutes noted. The
  machine paths reach the gate through the Host's `checkEnv`; no change to System. The DNA caller session "DNA 100K"
  carries it; its Items live in DNA's STATUS.md.
- Stays the operator's in that work: how the advisory is cleared, the evaluation check's fail rule and error budget,
  re-baselining, adjudication, the Items, approvals and releases. Held-out batches are never read by a Work. No
  unpublished probes by the scheduled session for now.
- Duties apart from that ranking, both the operator's: run sb-1's gated test (it needs the Account's token) before any
  rise of the night limit or of the number of repositories; put `codex` back on the Host's PATH (both Codex Accounts
  are unavailable, so the two Brainstorm proposals come from one Provider).
- IR (intent 6bb1d7c3f7a5, superseding 92cc952b1a96; operator, 2026-11-20, "Đồng ý toàn bộ" to option (b)): the 2026-11-19 decision stands; only IR batch 1 is opened (ir-1 to ir-6: ADR-0013 and five deterministic Guardrails, from 328 Works since 2026-11-10 with 64% of failures recurring), then work returns to DNA. Batches 2 and 3 (context-pack and file-overlap warnings, `guardrail.yaml`, a Model check of Done when, Triage in shadow and its gate, a doc-truth Model check) open only when `recurringClasses` on DNA's Works ask for them. Triage v1 only writes a diagnosis the reopened step reads and a hold recommendation; the controller is unchanged and rerunning a check stays the operator's (RO). The docs rule does not change in this range (EV's E3). Coordinated with the EV session (system-1b) on 2026-11-20. Batch 1 grew to 8 with ir-7 (core-budget measured the wrong base) and ir-8 (the pre-push hook changed the operator's repository), both fixing defects the batch itself found (operator, 2026-11-20). ir-9 (operator, 2026-11-20): "bỏ phần chặn, giữ số đo …"; the line budget becomes a trend.
- CT (intent 469fd00fd3dd; operator, 2026-11-20): checks in tiers by event; the decision and its trade-off are in [ADR-0014](docs/decisions/ADR-0014-checks-in-tiers-by-event.md). Order: ct-1, then a release, then ct-2; ct-3 after ir-3. Worker slots rise with the release that carries ir-3 and ct-1.
