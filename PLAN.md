# PLAN.md — System MVP-0 implementation handoff

> **Status:** MVP-0 done: M0 to M6 complete (local, CI and real agents on this host, PR #2). github.com itself is not exercised yet (no throwaway repository or token authorised); MVP-1 is not started. Worker auth uses subscription tokens (ADR-0005). This is an execution checklist for a local coding agent, **not** a new source of product requirements.
> **Updated:** 2026-11-05. Target: **MVP-0 only** on the current System branch.

## Goal and rules

Build the **smallest running DSH/Cordis-hosted System control plane** that proves:
- **Work/Task is primitive.** A simple Task runs with no public DAG or mandatory Workflow file.
- **Workflow is external declarative configuration**, initially minimal YAML (\`steps\`, \`dependsOn\`, \`capabilities\`, \`outputs\`, \`verify\`, \`accept\`); software and research differ by config, adapters and verifier capabilities, not a second controller.
- **Immutable Artifact IDs** are the only durable handoff between Workers. A separate attempt may use another provider with no previous chat context.
- **Verification is a typed, versioned capability**, bound to the exact subject Artifact and frozen criteria; no universal model-review stage.
- **Deterministic replay of recorded state**, not deterministic LLM output or blind retry of external effects.
- **One DSH-based runtime**, small active bundle; reuse infrastructure and community mechanisms before writing equivalents.

**Source of truth (read before implementation):**
1. [Product Charter](docs/requirements/purpose.md); [MVP contract including MVP-0/MVP-1 split](docs/requirements/mvp.md).
2. [ADR-0001: DSH control plane](docs/decisions/ADR-0001-control-plane-on-dsh.md).
3. [ADR-0002: Work vs Workflow](docs/decisions/ADR-0002-work-primitive-configured-workflows.md).
4. [ADR-0003: Artifact/verification](docs/decisions/ADR-0003-artifact-ids-and-verification-contracts.md).
5. **[ADR-0004: MVP-0 operating decisions](docs/decisions/ADR-0004-mvp-0-operating-decisions.md)** — controlling MVP-0 choices.
6. [Workflow architecture](docs/architecture/workflow-composition.md); [Artifact/verification architecture](docs/architecture/artifact-verification.md); [control-plane boundary](docs/architecture/control-plane.md).
7. [DSH source evaluation](docs/research/RES-0003-dsh-control-plane-evaluation.md), [System 1 audit](docs/research/RES-0004-reference-workflow-artifact-audit.md), [AGENTS.md](AGENTS.md), [docs governance](docs/governance/documentation.md).

**Operator instructions to local agent:**
- Implement in **small, reviewable commits**; after every milestone, run specified tests and record evidence in the progress table. A checkbox is not test evidence.
- Never silently alter accepted ADRs, replace the agreed storage strategy, or adopt a new workflow engine.
- Start by validating DSH composition and contracts. **Do not port entire System 1 packages**, especially \`workflow\` (~1.3 MiB plugin source) or \`agent-workers\` (~0.85 MiB); extract reusable algorithms/contracts/tests.
- **MVP-0 does not include security isolation or egress restriction**; do not introduce Docker, proxy, broad credential subsystem, MCP endpoint, UI or Website Workers now. Clean process env/worktrees are operational hygiene, **not a sandbox**.
- Only System's effect executor does authorized Git push and draft PR creation. No automatic merges. Do not let real automated tests push to a production repository.
- Every new source directory gets an ownership README and the documentation profile's \`source-roots\` must be updated when product code appears. Keep canonical specs updated separately; PLAN.md is only a handoff/checklist.

## Evidence baseline — pin exact versions before coding

**New System repository:** work on the checked-out branch without clobbering local uncommitted work. \`System_1\` is **external reference evidence**, not a predecessor to migrate or a source tree to copy wholesale.

**DSH:** pin release \`dsh-v0.2.2-rc.1\` and verify the tag/installed package integrity. GitHub's tag target on 2026-11-05 is **\`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db\`**. ADR-0004 mistakenly cites **\`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159\`**, a distinct master merge. **Verify and correct this discrepancy in a separate ADR/docs commit before locking dependencies**. Do not assume both commits are equivalent.

Relevant pinned DSH APIs:
- [subagent contract](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/subagent/subagent/src/types.ts): \`SubagentStartRequest\` supports \`cwd\` but requires parent \`Agent\`; \`SubagentResult\` has output/structured/stopReason/diagnostic, **not** usage or workspace changes. Compare before choosing wrapper vs direct SDK adapter.
- [Claude Code provider](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/subagent/subagent-claude-code/README.md) and [Codex provider](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/subagent/subagent-codex/README.md).
- [storage-domain](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/storage/storage-domain/README.md) with durable *record-level* writes, not cross-table transactions; [sdk-minimal composition](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/sdk-minimal/cordis.patch.yml).

**System 1 source baseline:** [\`tsuuanmi/system_1\`](https://github.com/tsuuanmi/system_1) \`main\` at **\`f199a277b2634f8995a499601cbf03616aa639f7\`**. Read code at pinned paths and check LICENSE/attribution before verbatim copying; repository visibility alone is not permission to reuse source.

## Milestones — execute in order

### M0: Reproducible DSH boot and CLI

- [x] Verify/pin DSH exact tag and runtime dependencies, correct ADR-0004 upstream hash in a small docs commit. *(\`d02fa55\`: tag is \`66491b05\`; \`fcc0ad4\` is 811 commits ahead; cited facts rechecked at the tag.)*
- [x] Create **minimal System profile/bundle** on Cordis; inspect effective active plugin rows and dependency closure. **Do not inherit full \`dsh-base\`** unless an actual required dependency forces it. *(\`@system/bundle\`: 7 rows, no \`dsh-base\`; \`--dump-config\` asserted by the smoke test.)*
- [x] Implement thin \`system\` wrapper for \`dsh --profile system "$@"\`; expose at least \`system doctor\` or equivalent health and \`system work\` namespace.
- [x] Enable/reuse DSH storage hub/domain, attachment/content store, subprocess and credentials only as actually needed; document which are mounted. *(packages/bundle/README.md; attachments and subprocess are mounted but first exercised in M1/M3.)*
- [x] Add reproducible build, typecheck, unit-test commands and offline smoke tests (no model credentials). One optional plugin can be disabled by config without deleting its source; in-flight toggling is MVP-1.
- [x] Record exact package versions, commands and limitations in source README.

**Gate M0:** profile boots, CLI health works, CI/offline test passes; no second model loop/plugin manager.

### M1: Artifact Foundation (first port target)

- [x] Define minimal typed Artifact envelope: \`artifactId\`, kind/version, content or blob ref, input Artifact IDs, classification, producer provenance and separate producer occurrence/attempt identity. *(packages/artifacts/src/envelope.ts; occurrences carry producer, workId, attemptId, time.)*
- [x] Port/adapt the **small** canonical JSON/SHA-256 utility and tests from [System 1 canonical.ts](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/packages/libs/src/canonical.ts) **only if copying is permitted**; otherwise reimplement behavior. Freeze versioned canonicalization and hash domain separation. *(Ported with the owner's permission; {B}artifact-id/v1{B} with domain tag {B}system.artifact/v1{B}, documented in artifact-verification.md.)*
- [x] Adapt [System 1 artifact invariants](https://github.com/tsuuanmi/system_1/tree/f199a277b2634f8995a499601cbf03616aa639f7/packages/plugins/artifacts) and [conformance tests](https://github.com/tsuuanmi/system_1/tree/f199a277b2634f8995a499601cbf03616aa639f7/packages/ledger-core/conformance) to DSH storage/attachment APIs; **do not add a second full SQLite ledger** by default. *(DSH storage domain {B}system_artifacts{B} plus attachments; no own database.)*
- [x] Enforce immutable content, schema validation, missing-input refusal, lineage and stable ID; persist metadata separately from content. Define how partial write/orphaned blob is reconciled. *(Bytes before record; an orphan blob is reused by the retry; deleted bytes read as {B}unavailable{B}. Orphan GC is not implemented.)*
- [x] Tests: same canonical content -> same Artifact ID despite different producer/time; different content -> different ID; producer events remain distinct; changed/invalid input refused; restart -> read by ID succeeds.

**Gate M1:** Artifact stored and read after process restart **by ID only**, stable digest and provenance verified.

### M2: Durable Work/Task + minimal Workflow file compiler

- [x] Define Work ID, Attempt ID, lifecycle/state events, terminal outcome and explicit decision reasons. *(\`work:<uuid>\`, \`attempt:<uuid>\`; events \`admitted\`, \`dispatched\` with every routing candidate and reason, \`observed\`, \`verified\`, \`attempt-lost\`, \`terminal\` with reason.)*
- [x] **Implement ADR-0004 storage literally:** \`ctx.storageDomain\` table \`work\`, **one key per Work**; each atomic \`update(workId, fn)\` stores Work's events, current state and effect intents/results. Artifact metadata is a separate content-keyed table; bytes use attachment store. Measure Work record size and handle cross-table crash boundaries. *(Domain \`system_work\`; a 3-step record is about 3.9 KB, bounded at 16 KB by a test; crash boundaries in packages/work/README.md. Effect intent/result events join the same record in M5.)*
- [x] Implement direct **single Task with no YAML**, fake Worker and persisted result Artifact.
- [x] Parse **external versioned YAML**, only \`steps\`, \`dependsOn\`, \`capabilities\`, \`outputs\`, \`verify\`, \`accept\`; keep code/research Workflow files as **data files** (proposed \`workflows/software-engineering.yaml\`, \`workflows/research.yaml\`). *(Also \`inputs\`, the Artifact-ID binding MVP-09 requires, and a required \`version\`; \`approval: operator\` replaces the sketch's \`operator-merge\`.)*
- [x] Preflight unique steps, cycles, missing refs/outputs, unknown Worker/verifier capability, invalid fields and versions **before any execution**.
- [x] Canonicalize/persist accepted resolved Workflow spec as Artifact ID. Editing/removing YAML changes future admissions **only**. Translate symbolic output slots to exact Artifact IDs before Worker handoff.
- [x] Persist dispatch/observations and recover Work state after restart **without replaying nondeterministic agent calls or remote effects**.

**Gate M2:** direct Task and both YAML fixtures execute through one fake controller; invalid YAML dispatches zero Workers; spec hash survives mid-run file edit and restart.

### M3: Worker registry + Claude Code / Codex

- [x] Define tiny Worker contract: capability descriptor, admit/reject reason, input Artifact IDs, per-attempt ID/cwd, cancel, output Artifact IDs, provider usage observation, terminal status. *(\`WorkerRequest\`/\`WorkerResult\` in packages/work/src/registry.ts: abort signal, \`cancelled\`, unaccepted \`partial\`, log Artifact, executor account/path/version.)*
- [x] Build capability-based registry and fake adapter first; record routing decisions and unavailable reasons. No hardcoded domain-specific branches.
- [x] Compare pinned DSH native \`subagent-*\` APIs with System needs. Use DSH subprocess/credentials and official Claude/Codex SDKs or **small, evidenced System-owned adapter** where DSH seam cannot expose required usage/worktree/result details. *(At the tag \`SubagentResult\` lacks usage and changes and needs a parent Agent, so \`@system/agents\` runs the CLIs through DSH \`subprocess\` (user-systemd scope ownership) and DSH \`credentials\`.)*
- [x] Create **new git worktree per attempt** from frozen input Artifact (not one shared worktree per whole Workflow), throwaway HOME, minimal selected provider credential environment; the adapter captures output tree/changes as Artifact.
- [x] Extract only needed Git helpers from [System 1 worktrees.ts](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/packages/plugins/agent-workers/src/worktrees.ts); do not inherit its worktree-per-run ownership or landing system.
- [x] \`system work cancel\`: process-group SIGTERM, 30 s, SIGKILL, persist reason/caller, retain partial output as **unaccepted** Artifact and reconcile pending effects.
- [x] Record bounded agent output and usage provenance; unobserved usage = **unknown**, not zero. Verify Claude -> Codex takeover from Artifact ID without transcript handoff.
- [x] *Operator-requested addition (2026-11-06):* model tiers as capabilities (\`tier.economy\`, \`tier.standard\`, \`tier.frontier\`, System 1's names); an account maps tiers to models; each attempt records tier, model and served models. *(Real check: Claude \`haiku\`/\`sonnet\`/\`opus\` served \`claude-haiku-5-5\`/\`claude-sonnet-5-5\`/\`claude-opus-5-5\`. Codex has no tier models configured.)*

**Gate M3:** fake tests + separately flagged real provider smoke tests show takeover, cancellation and output persistence. Credentials are optional for offline CI.

### M4: Verifier capability contract + two domains

- [x] Implement verifier registry: versioned capability, accepted Artifact kinds, exact subjectArtifactId, criteria Artifact ID, verdict \`pass | fail | inconclusive | error\`, evidence Artifact IDs and provenance. *(\`VerifierPort\`: version, accepted kinds, criteria pinned at admission; the controller stores \`verdict@1\` and refuses mis-bound or evidence-less verdicts as \`error\`.)*
- [x] Aggregate **only required verifiers selected by Workflow YAML**, not universal model review.
- [x] Code verifier: snapshot repo \`.system/checks.yaml\` at admission as criteria Artifact, run commands on **fresh worktree for the exact result tree Artifact**, record check/exit/evidence. Adapt exact-subject logic from [System 1 subjects.ts](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/packages/libs/src/subjects.ts) and [checks.ts](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/packages/plugins/agent-workers/src/checks.ts).
- [x] Research verifier: agent produces **\`report.md\` + structured \`sources.json\`** with URL, quote and supported claims. Verify source fetchability and quote presence at verification time; report inaccessible/changed sources as \`inconclusive\`. **Do not claim this proves what the agent originally read** (full source snapshot/fetch tool is MVP-1).
- [x] Tests: wrong/stale subject, changed criteria, missing verifier/evidence and failed checks do **not** pass; two very different domains use the **identical Work Controller code**.

**Gate M4:** code-tree check and research citation check produce typed verdict Artifacts against exact IDs; no domain-specific engine branch.

### M5: System-owned push/PR effects and operator approval

- [x] Implement Effect intent/outcome records with stable operation ID in Work record. **Persist intent first**, invoke remote operation second, then record result; an unknown state triggers read-only reconciliation before retry.
- [x] Effect provider can push verified code to \`system/<workId>\` and open **draft GitHub PR once**; only System receives Git/GitHub credentials. **Never auto-merge**.
- [x] Verify exact tree Artifact passed required checks **before push**.
- [x] Human-only approval at CLI for actions beyond allowed \`system/*\` push/draft PR, marking PR ready, or accepting inconclusive result; store \`operatorId\` and caller source. **MVP-0 caller labels are not an OS-level anti-bypass guarantee**.
- [x] Automated tests use fake GitHub/git effect backend. Manually authorized live smoke tests use only a throwaway repo. *(Automated: real bare git remotes and a fake GitHub API. **Live: not run**; no throwaway repository or token has been authorised.)*
- [x] Crash tests around intent, remote effect success before receipt, and reconciliation: no blind duplicate push/PR.

**Gate M5:** verified code produces **one** draft PR; restart/repeat reconciles its identity, never opens a duplicate.

### M6: MVP-0 end-to-end verification and handoff

- [x] Run **Software Engineering YAML** end-to-end: Work -> Worker -> code Artifact -> exact-tree checks -> System push -> draft PR. *(Dogfood: Work \`work:6bd9748e-e55f-45a6-a3c0-6545e54373dd\` fixed System's own \`tools/docs.py\` for Python 3.8 with Claude Code \`claude-haiku-5-5\`; the pinned \`.system/checks.yaml\` failed on the base and passed on \`aed1a25\`; System pushed it to \`system/6bd9748e…\` on a local mirror and opened draft PR #1 on the fake GitHub API; taken in as \`e99996b\`.)*
- [x] Run **Research YAML** end-to-end: Work -> Worker -> report/source Artifacts -> configured verifier -> accepted/inconclusive outcome. *(Work \`work:5b956495-bc74-40e2-9c38-9de71b2b15f9\`: Claude Code \`claude-haiku-5-5\` answered what MCP is with 2 sources (anthropic.com, modelcontextprotocol.io); both quotes were found on the live pages; accepted in 28 s.)*
- [x] Show Claude -> Codex takeover using Artifact IDs, no previous conversation, one Work history. *(Real, economy tier: {B}claude-haiku-5-5{B} cancelled mid-attempt, {B}gpt-6-luna{B} took over from the partial tree in the same Work; {B}tests/real-agents.test.ts{B}.)*
- [x] Test restart during admission/execution, artifact persistence and effect boundary; cancellation/partial Artifact; spec edit pinning; invalid config; stale verifier; direct Task without Workflow.
- [x] Document commands, environment variables by **name only**, example config, known limitations and observed outputs. Add per-package README and update canonical docs/ADRs for tested details.
- [x] Run \`python3 tools/docs.py check\`, \`python3 tools/docs.py sync --check\`, all relevant package build/typecheck/tests and CI. Add genuine test evidence and note any skipped credential-gated integrations.

**Gate M6:** both domains complete using **one controller**; work/artifacts survive restart; effects reconcile without blind retry; verifier evidence is exact-subject. A skipped/broken mandatory test is a blocker, not a pass.

## Port / reuse shortlist

| Component/source | Choice | Keep out |
|---|---|---|
| [System 1 canonical.ts](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/packages/libs/src/canonical.ts) | **Selective port** utility + tests, subject to license | rest of libs |
| [System 1 subjects.ts](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/packages/libs/src/subjects.ts) | **Selective port** exact tree capture | large host/sandbox |
| [System 1 artifacts and conformance](https://github.com/tsuuanmi/system_1/tree/f199a277b2634f8995a499601cbf03616aa639f7/packages/plugins/artifacts) | **Adapt semantic contract and tests** to DSH store | duplicate SQLite owner |
| [System 1 workflow/spec.ts](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/packages/plugins/workflow/src/spec.ts) | **Extract** validation/spec hashing | giant Workflow engine, team/vote/remediation |
| [System 1 workers](https://github.com/tsuuanmi/system_1/tree/f199a277b2634f8995a499601cbf03616aa639f7/packages/plugins/workers) | **Adapt** capability matching and refusal reasons | quota fleet scheduler |
| [System 1 worktrees/checks](https://github.com/tsuuanmi/system_1/tree/f199a277b2634f8995a499601cbf03616aa639f7/packages/plugins/agent-workers/src) | **Extract** Git/check mechanisms | huge agent-workers plugin |
| [System 1 turn receipts](https://github.com/tsuuanmi/system_1/blob/f199a277b2634f8995a499601cbf03616aa639f7/packages/plugins/turn-receipts/README.md) | **Learn** intent/reconcile tests | browser account model |
| DSH/Cordis host/storage/attachment/subprocess/credentials | **Reuse first** at verified version | second host or general model loop |
| Board, browser Website Workers, team voting, UI, gateways, advanced quota/memory | **Defer** | entire dependency closures |

**Package guidance:** logical components may be consolidated into fewer packages. Suggested seams: \`work\`, \`artifacts\`, \`workers\`, \`verification\`, \`effects\`. Workflow loader is a **pure library**; Workflow definitions are external files, **not plugins**. Split only when lifecycle/config demands it.

## After MVP-0 — explicitly deferred

- [ ] **MVP-1:** Docker/egress boundaries and stronger operator identity.
- [ ] **MVP-1:** System fetch tool with immutable URL/source snapshots as citable Artifacts.
- [ ] **MVP-1:** hot-disable/reload plugin with in-flight Work.
- [ ] **MVP-1:** usage oracle comparison and resource/cold-start benchmarks.
- [ ] **MVP-1:** MCP entry point and wider workflow syntax when justified.
- [ ] **Post MVP-1:** Website Worker / browser-driven brainstorming and research behind the same Worker contract.
- [ ] **After MVP-0:** align the capability vocabulary with System 1 (\`develop\`, \`research\`, \`review\`, \`plan\`, \`web-search\`) and migrate the two Workflow files.
- [ ] **After MVP-0:** tier bounds on a step (\`min\`/\`max\`, lowest open tier served, as System 1's work requirement) instead of one exact \`tier.*\` capability.
- [ ] **After MVP-0:** Codex model names per tier, verified against the installed CLI.
- [ ] **After MVP-0:** choose among several accounts by quota, cooldown or rotation (today: the first capable account).
- [ ] **After MVP-0:** schema evolution for stored records: one invalid stored record makes DSH refuse to open the whole domain, so every new field must be optional or defaulted until a migration runner exists.
- [ ] **After MVP-0:** consider an ACP runtime (DSH \`subagent-acp\` or a System one) for agents other than Claude Code and Codex.

## Status / evidence log (update after each milestone)

| Milestone | Status | Commit/PR | Test command and result / blocker |
|---|---|---|---|
| M0 DSH bootstrap | done | \`d02fa55\`, \`8b2d797\` on \`mvp0/implementation\` | \`corepack pnpm install --frozen-lockfile\` exit 0; \`corepack pnpm check\`: build + typecheck ok, unit 5/5, offline smoke 7/7 (boot; exact 7-row composition; optional \`credentials\` disabled gives ok; required \`storage-sqlite\` disabled gives exit 1; init idempotent). \`system doctor\` about 1.05 s, 89 MB RSS. GitHub Actions on PR #2: \`build\` pass (19 s), \`docs\` pass. |
| M1 Artifacts | done | \`26d91c0\` on \`mvp0/implementation\` | Clean \`install --frozen-lockfile\` exit 0; \`corepack pnpm check\`: unit 23/23 (18 new: canonical form, ID independence from producer/time, each content field changes the ID, distinct occurrences, input set order, refusals store nothing, classification floor, no relabel on dedup, immutable reads, crash between blob and record, unavailable bytes, concurrent equal puts, malformed IDs); smoke 10/10 (3 new: read by ID after a process restart, missing/malformed IDs, deleted bytes). Mutation check: putting the producer into the ID fails 2 tests; removing the per-ID lock fails 1. \`system doctor\` about 1.08 s, 91 MB RSS. GitHub Actions on PR #2 at \`b3c7ae6\`: \`build\` and \`docs\` pass. |
| M2 Work + YAML | done | \`77cf8e2\` on \`mvp0/implementation\` | Clean \`install --frozen-lockfile\` exit 0; \`corepack pnpm check\`: unit 49/49 (26 new), smoke 17/17 (7 new). Gate on the real profile with \`fakes\` enabled by patch: direct Task, Software Engineering and Research succeed through one controller; an invalid Workflow is refused with zero Worker calls and no Work; host SIGKILLed mid-attempt, file edited, \`work run\` keeps the pinned spec ID, re-runs only the lost step (2 \`implement\` attempts, 1 \`checks\`) and succeeds; \`work replay\` matches; fakes disabled gives the missing-capability reason; SQLite WAL with \`synchronous=2\` (FULL) asserted. Bugs found by tests and fixed: dependency-order hash instability, \`\$steps\` reference parsing, replay comparison under storage key reordering. \`system doctor\` about 1.1 s, 93 MB RSS. GitHub Actions at \`77cf8e2\`: \`build\` and \`docs\` pass. |
| M3 Workers | done | \`e72a761\` (ADR-0005), \`a42f329\`, \`d111da4\` on \`mvp0/implementation\` | Clean install exit 0; \`corepack pnpm check\`: unit 64/64, smoke 22/22 (2 credential-gated skipped in CI). Fake-CLI tests: exact pinned commit on the base, file outputs, env stripped to PATH/LANG/LC_ALL/TZ plus the account credential, SIGTERM cancel with partial tree, SIGKILL after grace, per-attempt \`CODEX_HOME\` with refresh copy-back, cross-process \`work cancel --wait\` (exit 5), contested \`work run\` refused, Codex takeover from the partial commit with \`replay\` matching. **Real, on this host** (\`SYSTEM_REAL_AGENTS=1\`): Claude Code 2.1.311 made a real change captured as a commit with observed usage (15 s); Claude cancelled mid-\`sleep 45\`, Codex 0.166.0 took over from its partial tree in the same Work (59 s), usage observed for Codex and recorded unknown for the killed Claude attempt. Probe finding: Codex writes memories/state into a shared \`CODEX_HOME\` even with \`--ephemeral\`. Bugs fixed: cancel poll kept a hung process alive; in-process cancel was refused. GitHub Actions at \`d111da4\`: \`build\` and \`docs\` pass. |
| M4 Verifiers | done | \`32d5cee\` (tiers), \`51a3991\` on \`mvp0/implementation\` | Clean install exit 0; \`corepack pnpm check\`: unit 81/81, smoke 28/28 (2 credential-gated skipped in CI). Gate on the real profile (\`tests/verify.test.ts\`): both repository Workflow files through one controller with real verifiers; SE change passes the base commit's pinned checks, a failing change fails with the check named, a base without \`.system/checks.yaml\` is refused at admission; Research quotes found at a local site pass, unconfirmable ones hold (exit 3), an empty sources file fails; verdict Artifacts carry the exact subject and criteria IDs. Unit: wrong subject, other criteria, pass without evidence, unstored evidence, unaccepted kind → \`error\`; \`retry --step\` re-verifies the new subject; static check that the controller names no domain. Real (\`SYSTEM_REAL_AGENTS=1\`, economy tier): Claude Code \`haiku\` change, then Haiku cancelled and \`gpt-6-luna\` took over. Found and fixed: the M4 state field broke opening the real profile's M3 records (now defaulted, with a compatibility test); a test site blocked by \`spawnSync\`. GitHub Actions at \`51a3991\`: \`build\` and \`docs\` pass. |
| M5 GitHub effects | done (fake GitHub) | \`9a0fe20\` on \`mvp0/implementation\` | Clean install exit 0; \`corepack pnpm check\`: unit 102/102, smoke 33/33 (2 credential-gated skipped). TDD: effect-step compiler, controller effects (10 scenarios) and the GitHub publisher (9) were written red first. Gate on the real profile (\`tests/publish.test.ts\`): the SE file publishes the exact checked commit to \`system/<work>\` on a bare remote and opens one draft PR; running again adds nothing; host SIGKILLed by the fake API right after it created the PR is reconciled as applied (1 PR); host SIGKILLed by a pre-receive hook during the push is reconciled as absent and published once; \`ready: true\` holds the Work, a pipe or \`SYSTEM_CALLER=human\` cannot approve, a typed confirmation on a pseudo-terminal approves, \`deny\` fails it; no merge call. Branch moves only from System-pinned commits. Refactor: host control and \`WorkError\` moved out of the controller. GitHub Actions at \`9a0fe20\`: \`build\` and \`docs\` pass. Not run: github.com. |
| M6 MVP-0 E2E | done | \`a4007c9\`, \`e99996b\` (made by System), \`40058f3\` on \`mvp0/implementation\` | Clean \`install --frozen-lockfile\` exit 0; \`corepack pnpm check\`: unit 105/105, smoke 33/33 + 2 credential-gated skipped in CI; docs check, sync, impact and the bootstrap smoke pass on Python 3.8. Real, on this host: SE dogfood and Research end to end (above); \`SYSTEM_REAL_AGENTS=1\` 2/2 on the final code (Claude change 11 s; Claude→Codex takeover 130 s). Restart during admission (characterised), execution, effects, cancel, spec pinning, invalid config, stale verdicts and direct Tasks are covered by the M2–M5 tests. Found and fixed: agent version probes cost 0.9 s per command (now lazy). **Open:** one real takeover run recorded the cancel directly (\`attempt-lost\`) as though the submitting host had died about 9 s in; it did not reproduce in three later runs, and the test now reports host stderr. GitHub Actions at \`40058f3\`: \`build\` and \`docs\` pass. Not run: github.com. |

**Stop and report** if: pinned DSH APIs are incompatible; accepted ADR conflicts with reproducible source; single-key Work size or crash behavior is inadequate; an external effect cannot be reconciled; a second domain needs controller branching; or a license prevents porting source. Provide the smallest reproducer and propose a measured fix. **Do not silently redesign the architecture**.

**Definition of done:** reproducible local MVP-0 with two workflows, restart and takeover proofs, exact Artifact-ID verification, reconciled effects, a small DSH composition, and recorded test evidence. Until then this plan is **not** a claim that System is implemented.
