---
id: RES-0014
type: research
status: active
summary: What kind of system System should be next - its stated identity against its records of 2026-11-10 to 2026-11-21 and primary sources on comparable systems; four candidate identities and one recommendation.
related: [ADR-0001, ADR-0012, ADR-0013, ADR-0014, ADR-0015]
---

# What kind of system System should be

**Research as of 2026-11-21; evidence for a decision, not the decision.** Written by a caller session
for the operator's question "System nên là một hệ thống như thế nào". Nothing here is settled by the
operator. Sourced facts and judgement are kept apart: each section says which it holds.

How the outside sources were read: each linked page was opened on 2026-11-21 through a fetch tool
that returns extracts; a quotation is the tool's extract of that page, not a copy checked by eye.

## Question

Which identity should System hold for its next stage: what it owns, what it leaves to others, and
which properties are load-bearing?

## 1. What System says it is (facts, from the repository)

- **Identity.** "System is a durable work control plane for replaceable AI Workers ... rather than
  being another general-purpose model loop", for one operator across several repositories
  ([Charter](../requirements/purpose.md), Identity).
- **Mission and measure.** It "turns the operator's Intents ... into results (verified changes in
  their repositories, verified research reports) with as little of the operator's attention as
  possible"; the headline measure is verified Items merged per operator act (Charter, Mission and
  Headline measure).
- **Purposes.** P1 work continuity, P2 one core for Software Engineering and Research, P3 bounded
  autonomy (Charter, Fundamental purposes).
- **Ownership.** System owns "durable work identity, lifecycle, result/artifact references,
  cross-Worker handoff, authorization decisions, effect reconciliation, verification provenance and
  operator decision records"; the agent loop and plugin composition are DSH's
  ([ADR-0001](../decisions/ADR-0001-control-plane-on-dsh.md), Decision 1 and 2).
- **The Host does not plan.** It "carries on, never picks": choosing an Item, writing its Task and
  submitting it is a caller's act, scheduled sessions included; Item state is derived from STATUS.md
  and the records, never stored
  ([ADR-0012](../decisions/ADR-0012-host-carries-works-on-never-picks-items.md), Decision 1 to 3).
- **Acceptance.** A verdict is bound to an exact Artifact ID and criteria
  ([ADR-0003](../decisions/ADR-0003-artifact-ids-and-verification-contracts.md), Decision 6); "a model
  may choose what to try next and may block ... It never accepts"
  ([ADR-0013](../decisions/ADR-0013-models-decide-what-to-try.md), Decision 1).
- **Speed against coverage.** Heavy checks run once per release instead of once per Work, and the
  operator accepted that a defect only they catch can reach `dev`
  ([ADR-0014](../decisions/ADR-0014-checks-in-tiers-by-event.md), Trade-off).
- **Changeability.** Judged by Items merged on their first Work, the Recurring Failure Rate and the
  Time to Verified Resolution; the core's lines are a trend, not a gate
  ([ADR-0015](../decisions/ADR-0015-changeability-is-measured-not-budgeted.md), Decision 1 and 2).
- **Non-goals.** A new agent loop, a replacement for the DSH plugin manager, a full project board, a
  rich dashboard, universality without an executed second domain (Charter, Explicit non-goals).
- **Earlier research** found no case for a new engine, database, scheduler or agent runtime, and kept
  Temporal, BullMQ and GitHub's merge queue as reference only
  ([RES-0012](RES-0012-reuse-first-research-2026-11-14.md), "Became CM Items" and "Not yet Items").
- **The operator's decision of 2026-11-19:** the review of System itself ends and "the next return is
  sought in the product DNA through System" (PLAN.md, the EV lines of 2026-11-19 at the end of the
  file).

## 2. What the records show (facts, from the Host's records)

`system work report`, two ranges (run 2026-11-20 and 2026-11-21):

| | 2026-11-10 to 2026-11-18T09:29Z | since 2026-11-18T09:29Z |
|---|---|---|
| Works | 341 | 67 |
| Accepted | 289 (84.8%) | 58 (86.6%) |
| Cost per verified Work | $0.57 | $0.34 |
| Time to verified resolution, median / p90 | 13.9 / 53.7 min | 6.9 / 23.4 min |
| Failures of class `unknown` | 29 | 1 |
| Recurring Failure Rate | 64% | 32% |
| Escaped defects recorded | 5 | 0 |
| "Items merged" per operator act | 203 / 56 = 3.6 | 38 / 16 = 2.4 |
| Active core lines, start to end | 3,599 to 5,126 | 5,126 to 5,376 |

The two ranges hold different work, so the columns are not a controlled comparison.

Counted from `system work show` for every Work since 2026-11-18T09:29Z (reflection record, file
Artifact `sha256:6f16b4c31beaeda3addd3063e9751d3cea64eecf847c6eda87bcfecd7b92e5df`):

- 20 Items merged in System and 5 in DNA; 36 Works named no Item (research, brainstorm, docs, release
  and install checks). By Items the headline is 25 for 16 acts, 1.6 per act: the report's 38 counts
  merged Works that name no Item.
- 23 of the 26 merged Works with an Item needed one implement attempt.
- Only Claude Code Accounts hold `develop.implement`; both Codex Accounts have no capability
  (`~/.system/profile.yml`, read 2026-11-20). Every change therefore came from one provider.
- The sandbox option is merged and off on every Account, and its real-agent test has not been run
  (PLAN.md, the sb-1 lines at the end of the file).

The first unattended night on a product (night report, file Artifact
`sha256:71d7570c04b68f26e226d3e9db8c0dbdeac404eeaa713fd0e6247a6297430f8d`): 48 minutes, three Works, both
DNA Items merged into `dev`, about $1.47, nothing held, no operator act during the night. One Work
failed twice on DNA's `repository-policy` check and the session submitted a second Work that passed.
The report also says: all three Works skipped `satisfied-check` and listed no changed test, and the
second Task carried nothing from the failed Work. Checked on 2026-11-21 with `git show`: both merges
hold tests (DNA d7b896af adds `tools/python/tests/test_t2_summary.py`, a7628341 adds three tests in
`src/report/review/items.rs`), so the empty list is a gap in what System records, not a missing test.
The other two observations are unverified.

### The gap between the stated identity and the observed one (judgement on the facts above)

| Stated | Observed |
|---|---|
| Replaceable Workers | One provider does every change; replacement is tested, not exercised. |
| Two domains on one core | Every merged Item is a code change; research runs as input to a caller. |
| Least operator attention | Cheaper and faster Works; Items per operator act fell, 3.6 to 2.4. |
| Work for the operator's repositories | Four fifths of the merged Items since the review changed System itself. |
| Bounded autonomy | Holds where deterministic or server-side; the Worker boundary is a Guardrail. |
| State outside sessions | Holds for Works, Artifacts, Items; not for talk between caller sessions. |

Notes on the rows. Research and Brainstorm Works ran often (they are most of the 36 Works with no
Item) and none was a merged outcome. The fall in the headline came with nine Intents for small
batches, three releases and four human touches. Autonomy is bounded by a protected `main`, the
checks and approvals at a terminal; the Charter itself calls the Worker Guardrail "not a sandbox".
Three caller sessions coordinated on 2026-11-20 by messages System does not record; only
`item_claim` was recorded.

The part of the identity the records support without reservation is narrower than the Charter's
sentence: **a gate and a ledger for changes to one operator's repositories.** The supply of Items,
which earlier records found to be the constraint (cycle-1 record, file Artifact
`sha256:30fe596df98cf88e636ec83b9bf1467b7c724f30d90432d96f87577493b4c05a`, finding 1), is outside
what System owns today.

## 3. Comparable systems (facts from primary sources; "take" and "refuse" are judgement)

Earlier records already settled, and this note does not reopen: which durable-execution practices
fit (replay of recorded histories in CI, a deadline on every wait, seeded crash tests) and which do
not (worker versioning, patch markers); that the agent vendors isolate the file system, the network
or both; that multi-agent debate has evidence against it (round-2 record, file Artifact
`sha256:8fcf3b5dd382a0f32dada2a197195357ea564d3a57f2b68d613df8de7a8c28a1`, finding 8).

### 3.1 Durable execution engines

- Temporal: a Workflow Execution is "a durable, reliable, and scalable function execution"; it
  resumes by replay, where generated Commands "are checked against an existing Event History"
  ([Workflow Execution](https://docs.temporal.io/workflow-execution)). "Temporal Application
  developers are responsible for developing Worker Programs and operating Worker Processes", workers
  "are external to a Temporal Service", and the service "doesn't execute any of your code"
  ([Workers](https://docs.temporal.io/workers)).
- DBOS: a library; "There's no separate orchestration server and no infrastructure required besides
  Postgres". The developer keeps two duties: "The workflow function must be deterministic" and
  "Steps should be idempotent" ([Architecture](https://docs.dbos.dev/architecture)).
- **Owns:** the history of a function's execution and its resumption. **Leaves:** what the function
  does, whether a step is safe to repeat, whether the result is right, who may approve.
- **Take:** the same split System already has (the service records and resumes; workers run the
  code). **Refuse:** becoming this family. These engines accept any function and verify nothing;
  System's value starts where they stop, at "is the result accepted" and "who may let it through".

### 3.2 Gating and merge queues

- Zuul: gating "attempts to prevent changes that introduce regressions from being merged"; "A gating
  system should always test each change applied to the tip of the branch exactly as it is going to be
  merged". Its dependent pipeline runs jobs in parallel by "speculative execution": a queued change
  is tested with "the changes ahead of it, with the assumption they pass", and "if one fails, then
  changes that were expecting it to succeed are re-tested without the failed change"
  ([Project gating](https://zuul-ci.org/docs/zuul/latest/gating.html)).
- GitHub merge queue: it "will ensure the pull request's changes pass all required status checks"
  "when applied to the latest version of the target branch and any pull requests already in the
  queue"; CI must run on the `merge_group` event; settings include build concurrency, minimum and
  maximum group size, a status check timeout, and "Only merge non-failing pull requests", which when
  off lets "pull requests that have failed required checks" join a group as long as the last one
  passes. A pull request leaves the queue when "a queue check fails". The two pages:
  [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)
  and
  [Merging a pull request with a merge queue](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/merging-a-pull-request-with-a-merge-queue)
- bors-ng: "a continuous-testing workflow where the main branch never breaks"; two pull requests
  that each pass against the main branch can break it together; it "tests them in batches (and
  bisects if a batch fails)". The repository is archived (2024-04-04) and its README recommends
  "GitHub's built-in merge queue" ([README](https://github.com/bors-ng/bors-ng)).
- **Owns:** one invariant, that the branch only ever advances to a commit that was tested as merged.
  **Leaves:** who writes the change, what the tests are, review.
- **Take:** the invariant is the centre of System's own promise ("nothing merges that its checks did
  not pass", PLAN.md section 3, EV) and System already tests the merge commit. One precise lesson for
  ct-3's batch mode: GitHub exposes "failed pull requests may ride in a group" as a named setting an
  owner turns on. System's batch mode checks a batch with the head Work's pinned criteria only, with
  no such named choice (reported in this effort on 2026-11-20; `mergeBatchSize` is unset).
- **Refuse:** speculative parallel queues. They pay when changes wait on the queue; the cycle-1
  record measured 62 of 549 publish minutes to gain, before ADR-0014 shortened the merge re-check.

### 3.3 Coding-agent control planes and background agents

- OpenAI Codex cloud: "Each task has its own workspace and can keep working while your computer is
  asleep"; the user can "inspect changed files and check results, request follow-up changes, and
  commit or open a pull request when you're ready"
  ([Codex cloud](https://learn.chatgpt.com/docs/cloud), reached from developers.openai.com/codex/cloud).
- GitHub Copilot cloud agent: it "can research a repository, plan changes, and implement them in the
  background"; it "can only work on one branch at a time and can open one pull request per task";
  "Review and test the output before using it in production" ([About the coding
  agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)).
- Claude Code: `claude -p` runs one non-interactive session that "exits with code 0 on success and a
  non-zero code when the run fails"; for unattended runs `--permission-prompts none` denies what
  would prompt ([Run Claude Code programmatically](https://code.claude.com/docs/en/headless)). A
  subagent "runs in its own context window", "returns only the summary", and "Subagents work within
  a single session" ([Subagents](https://code.claude.com/docs/en/sub-agents)).
- OpenHands: an SDK ("a composable Python library for building agents that work with code"), an Agent
  Server, a browser client and a managed cloud ([docs](https://docs.openhands.dev/)). The page read
  says nothing about what happens to a result.
- Gas Town: "Multi-agent orchestration system for Claude Code, GitHub Copilot, and other AI agents
  with persistent work tracking". It has a Mayor ("your primary AI coordinator"), Polecats ("worker
  agents with persistent identity but ephemeral sessions"), Hooks ("git worktree-based persistent
  storage for agent work"), Beads ("git-backed issue tracking"), a Refinery ("per-rig merge queue
  processor"), a Witness that detects stuck agents and a Deacon ("background supervisor"); it aims
  to "scale comfortably to 20-30 agents" ([README](https://github.com/steveyegge/gastown)).
- **Owns:** the agent session, its workspace and, in the vendors' clouds, its isolation. Gas Town
  also owns coordination between agents and a model that plans. **Leaves:** in every vendor page
  read, acceptance: a person reviews, then commits, opens or merges the pull request.
- **Take:** the vendors' isolation, configured and not rebuilt (sb-1 does this for Claude Code). From
  Gas Town, one idea only: work state that survives in git, which git-1 began and ADR-0012 defers.
- **Refuse:** supervising agent sessions, a coordinating model in the Host (ADR-0012 and ADR-0013
  already refuse it), and scale by agent count. The records show idle Accounts and an empty queue,
  not too few agents.
- **What this family does not offer,** on the pages read: a merge without a person's review of each
  change, on the strength of pinned criteria; one record across vendors from Intent to Verdict; a
  count of the operator's acts. That is the space System's identity can claim.

### 3.4 Reconciliation controllers

- Kubernetes: "controllers are control loops that watch the state of your cluster, then make or
  request changes where needed. Each controller tries to move the current cluster state closer to
  the desired state"; "It's useful to have simple controllers rather than one, monolithic set of
  control loops that are interlinked. Controllers can fail, so Kubernetes is designed to allow for
  that"; "The Job controller does not run any Pods or containers itself"
  ([Controllers](https://kubernetes.io/docs/concepts/architecture/controller/)). A controller's job
  is to ensure the actual state "matches the desired state in the object"; "We call this process
  reconciling" ([Kubebuilder book](https://book.kubebuilder.io/cronjob-tutorial/controller-overview)).
  Neither page read uses the term "level-triggered"; this note does not rely on it.
- **Reading (judgement).** System already has this shape for delivery: STATUS.md is desired state,
  the Host's records are observed state, `system status` derives the difference and stores nothing
  (ADR-0012, Decision 3), and a caller such as the scheduled session is the loop that acts on it.
  What has no loop is the layer above: nothing compares a product's measure with its target and
  turns the difference into Items. On DNA that loop ran by hand (next-ROI record, file Artifact
  `sha256:5b8c7fb8da223989d3919069eac14232cdff192d186ac08909af1c64ef83da41`, Facts).
- **Take:** several simple loops, each allowed to fail, and none of them inside the Host. A supply
  loop, if built, is one more caller with its own Workflow. **Refuse:** one planner that owns all
  of it.

### 3.5 First-party guidance on harnesses and evaluation

- Anthropic, building agents: workflows are "systems where LLMs and tools are orchestrated through
  predefined code paths", agents are where "LLMs dynamically direct their own processes"; the advice
  is "finding the simplest solution possible, and only increasing complexity when needed"
  ([Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)).
- Anthropic, long-running work: "each new session begins with no memory of what came before"; the
  harness bridges sessions with a feature list whose entries start as failing, "work on only one
  feature at a time", a clean state and a commit at the end of each session; observed failures were
  doing too much at once and a later session choosing to "declare the job done" ([Effective
  harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)).
- Anthropic, harness design: agents asked to judge their own work "tend to respond by confidently
  praising the work", so the evaluator is separate; "every component in a harness encodes an
  assumption about what the model can't do on its own", and such components were removed when a
  newer model no longer needed them; the full harness cost over 20 times a solo run ([Harness
  design](https://www.anthropic.com/engineering/harness-design-long-running-apps)).
- Anthropic, evals: "it's often better to grade what the agent produced, not the path it took";
  regression evals "should sit near 100%"; "20-50 simple tasks drawn from real failures is a great
  start"; "Teams without evals get bogged down in reactive loops" ([Demystifying
  evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).
- OpenAI, harness engineering: "Humans steer. Agents execute."; the repository's `docs/` is "treated
  as the system of record"; architecture rules "are enforced mechanically via custom linters" whose
  messages tell the agent the remedy; with agent throughput above human attention the team uses
  "minimal blocking merge gates", which the post says would be irresponsible at low throughput;
  drift is handled by recurring cleanup agents; "What we don't yet know is how architectural
  coherence evolves over years in a fully agent-generated system" ([Harness
  engineering](https://openai.com/index/harness-engineering/)).
- StrongDM's software factory: "Code must not be written by humans", "Code must not be reviewed by
  humans"; scenarios are kept outside the codebase like a "holdout" set, and "satisfaction", a
  probabilistic measure over runs of scenarios, replaces a green test suite
  ([Software Factory](https://factory.strongdm.ai/)).
- **Take (judgement).** Four things these sources agree on and System already half holds:
  1. State lives in files a fresh session reads (Items, Artifacts): keep, and close the hole of
     coordination by unrecorded messages.
  2. The judge is not the author, and judges outcomes: ADR-0013 has it; the night's Works that
     recorded no changed test although their merges hold tests (section 2) are the place to look first.
  3. Evaluation is what makes unattended change safe, and it belongs to the product: DNA's
     regression gate is a regression eval in the product's own checks file, and DNA's held-out
     batches match the factory's holdout (PLAN.md, the DNA Intent lines at the end of the file).
  4. Every harness part is an assumption to retest: System's closing simplification pass exists
     (PLAN.md section 2); it has no rule that asks "does a newer model still need this step".
- **Refuse (judgement).** Minimal merge gates: OpenAI ties them to very high throughput, and System's
  throughput is bounded by Item supply. Dropping human review is already System's position for
  `dev`; dropping the operator's release is not supported by anything in the records.

## 4. Candidate identities (judgement)

Costs are stated against the two things the Charter measures: the operator's acts and the ability to
change (ADR-0015).

### A. The gate and the ledger for one operator's repositories

- **Owns:** Work and Artifact records; verdicts bound to an exact subject; the merge into `dev`; the
  boundary of who may approve, deny or release; the count of operator acts.
- **Leaves:** the agent loop and its isolation (vendors, configured by System); what to do next
  (callers); what "correct" means for a product (the repository's checks); the release (operator).
- **Cost:** none new. It is the part of today's core that the records exercise.
- **For:** one-attempt merges 23 of 26; the night of 2026-11-21 ended with nothing held and nothing
  merged that failed a check; no vendor page read offers an unreviewed merge on pinned criteria.
- **Against:** on its own it does not move the headline. A perfect gate with an empty queue merges
  nothing, and the headline fell while the gate improved.

### B. A general durable workflow engine

- **Owns:** any multi-step process in any domain, as configuration.
- **Cost:** the apparatus of section 3.1, in a core that grew 49% in ten days.
- **For:** P2 and the tests that pin two domains.
- **Against:** every merged Item is a code change; research runs as input, not outcome; the engines
  that own this space verify nothing, so generality adds no part of the headline; the Charter's own
  non-goal is "claiming universality without an executed second domain".

### C. An agent runtime or fleet supervisor

- **Owns:** agent sessions, their supervision, their sandbox, coordination between agents.
- **Cost:** a second product to maintain against vendors who ship theirs monthly; operator acts for
  its upkeep.
- **For:** the Worker boundary is the weakest pinned guarantee (a Guardrail, sandbox off).
- **Against:** a Charter non-goal; Accounts sit idle, so agent count is not the constraint; the
  isolation needed is a vendor feature to configure (sb-1), not to build.

### D. A product-improvement loop that owns evaluation

- **Owns:** turning a product's measure into Items (census, probe, evaluate, propose), evaluation
  sets and their holdouts, the batch that goes to the scheduled session.
- **Cost:** large if it enters the Host (domain logic in the controller, against ADR-0001 Decision
  5 and ADR-0012); small if it stays a caller's Workflow plus checks in the product's repository.
- **For:** supply is the measured constraint; DNA's gains came from this loop run by hand; the one
  unattended product night worked once Items existed; sections 3.4 and 3.5 point at this missing
  loop.
- **Against:** the operator kept the error budget, adjudication, re-baselining and the Items for
  themselves (PLAN.md, "Stays the operator's in that work"); "plan-items" has one measured sample;
  the operator's minutes per DNA Item, split into running and judging, are still unknown (next-ROI
  record, last paragraph).

## 5. Recommendation (judgement)

**System should be A, and should grow D as configuration outside the Host; it should stop presenting
itself as B and never become C.** In one sentence: *System is the gate and the ledger through which
one operator's repositories change without the operator watching, and the place where product
evidence becomes a batch of Items the operator accepts in one act.*

Load-bearing properties:

1. **Acceptance is deterministic and tied to the exact change.** A model or a session may propose
   and may block; only checks whose criteria were pinned let a change into `dev`, and the merge
   commit is what is tested (ADR-0003, ADR-0013; Zuul's rule in section 3.2). Every relaxation is a
   named, recorded choice like ADR-0014, never a side effect like ct-3's batch criteria.
2. **Everything a new session needs is a record.** Items, Intents, Works, Verdicts, night reports and
   the decisions between sessions. The test: a session that has read only the repository and the
   Host's records makes the same next move.
3. **The operator's act is the unit of cost, and supply is part of the system.** Work is shaped so
   that one Intent, one batch and one release carry many Items; the loop that proposes Items from a
   product's measure is a first-class caller Workflow; no act is spent on System itself unless a
   product's records ask for it.

System is not:

- an agent loop, an agent supervisor or a sandbox of its own;
- a general workflow engine for arbitrary processes;
- the owner of a product's evaluation content, error budget or release;
- a planner inside the Host;
- a model reviewer that accepts;
- a platform for more than one operator.

What would change this recommendation:

- **Toward D inside System:** two or three DNA batches where the operator's minutes are mostly
  running the loop, not judging, and the loop cannot be written as a Workflow and repository checks.
- **Toward C:** sb-1's real-agent test fails in a way configuration cannot fix, or a second
  provider's CLI has no usable isolation.
- **Toward B:** an Intent from the operator in a third domain whose outcome is merged or published
  through System, not only read by a caller.
- **Against A's narrow gate:** late-caught or escaped defects rise under ADR-0014's tiers; or a
  hosted merge queue with a vendor's background agent gives the same unreviewed, recorded merges
  for fewer operator acts on the operator's own repositories.
- **Against the whole:** Items per operator act on product batches stays under the 3.6 measured
  before the review after three batches.

## Not established

- Sources not opened: Graydon Hoare's post on the rule bors enforces
  (`graydon2.dreamwidth.org/1597.html`, HTTP 403); GitHub's "Risks and mitigations" page for the
  Copilot agent (its push and approval limits are in the round-2 research report, not re-read here);
  the first URL tried for GitHub's merge queue page (HTTP 404, replaced by the one cited).
- OpenHands: only the documentation's front page was read.
- Gas Town: only the README was read; nothing here says how it behaves in use.
- Of the night report's three observations (section 2), two are the scheduled session's own and
  unverified: the skipped `satisfied-check` and the second Task that carried nothing from the failure.
- No source read measures operator attention per merged change; the headline measure has no outside
  reference point.
