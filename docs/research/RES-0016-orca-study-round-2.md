---
id: RES-0016
type: research
status: active
summary: Second round of the Orca study (2026-11-26), aimed at the day's own records - merge conflicts, docs-impact failures, an empty Worker output, unknown costs, a model comparison - with six Research Works, seven subagent studies and a scan of the stored Artifacts; Items redact-1 to runbook-1.
related: [RES-0015, ADR-0011, ADR-0015]
---

# What System can take from Orca, round 2

**Research as of 2026-11-26; evidence for a decision, not the decision.** It follows [RES-0015](RES-0015-orca-study.md)
(same Orca commit `196cf89`, MIT, Lovecast Inc.) and asks what Orca teaches about the failures System recorded that day.
The operator settled Intent `sha256:f3003547e10c7e96ec63c75137f5836d337e7e206d4a42028c33cc8bc811a812`; its Items are
redact-1, agyhome-1, ctx-1, finish-1, reopen-1 and runbook-1 in [STATUS.md](../../STATUS.md). Everything else below is a
candidate.

## Sources

Six Works of the repository-only research Workflow (as in RES-0015); five passed `research.citation-check`, `docsync`
failed it (its report is used and marked *unverified*).

| Topic | Work | Worker | Report |
|---|---|---|---|
| Parallel workers and conflicts | `work:7fda0a3e-13cc-5c89-a0b5-69ef27fc3dcb` | codex/x2 | `sha256:59090cac12ed5704fe24cb736eebf38906e37bb553fc691122aa03524d019a1b` |
| Worker preamble and completion | `work:b96e99db-95d1-5d11-9527-0318f49000c3` | claude-code/default | `sha256:4c9aad8d452c5e73ab8872c3166863cd620a2334b1d13ef2d65a2e7c232e641e` |
| Evaluation harnesses | `work:3a32be7d-98ce-5d5c-8ad3-1568684e3a1c` | claude-code/default | `sha256:0fd7f427b7bbd0985450ab9b3cc330aced986aa62b59faa34375289b95a698ea` |
| Cost accounting | `work:4dff39db-e815-5eb4-94e4-962bb6d4cda8` | codex/default | `sha256:322d261ec497373d03657976ff6ad829e5a67c2d8d4ce37e6104a1399946a9a4` |
| Skill guides and agent instructions | `work:c836eda2-4aa2-5c0b-b822-16c71f73de8f` | codex/default | `sha256:12d0c05a0844b7aaabfac8b6c3f8abbe329fb7026b9c1031856432022a5e60a1` |
| Keeping docs current (unverified) | `work:a5d7f83e-3484-5f38-9a12-8728ddaeef60` | codex/default | `sha256:bb38aef644c534b09a8bfb7991fb3c478150ef8a0041d94b4d9402327fde5cc4` |

Seven subagent studies (no citation check), stored as Artifacts: why Codex and agy end without their output
`sha256:e3a1a28d50477689984443d0e95e9cfdfcefc1dd4955b972d18b76e01c0753aa`; conflict and docs-impact hot spots in
System's records `sha256:636d5896c4fa8afa125a72019ac67147b37069ffb29a4b90d14b65c808b77c13`; the fix loop after a failed
check `sha256:7c45d7542dc80e8a54275698fa2322a1e86c66ee1a40f81d7471e82f4b352904`; secret redaction
`sha256:45adcda6fb8d4166e5ba818f518dea916614e5f1613898a74510cd5dc0e983d2`; a ratchet design
`sha256:6723173aa87872c43ba1ed96aade9d88ac8d597ce0c2dd32756444da62cfc7e7`; worker environments
`sha256:890d0b1bf0136bf1286d72d6e15f88b7a4043dbdc60d875198c9a7e4e368e981`; decision prompts for the operator
`sha256:db4125fcc908babfee59aa158f6908d1393d967fc2628de3e112ff903d690676`. The caller session checked the claims behind
the settled Items against System's code and scanned the stored Artifacts itself.

## Findings that became Items

- **Logs are stored unredacted (redact-1).** An attempt's log is stored as an immutable Artifact after bounding only
  (`packages/agents/src/lifecycle.ts`), while a Claude Code Worker holds its OAuth token in its environment; a tool that
  prints the environment would put the token in a permanent Artifact. A scan of the 4,394 stored Artifacts and the
  Host's store found no token-like string. Orca applies one redactor (`src/shared/observability/redactor.ts`) to traces,
  bundles, crash reports and agent-protocol logs.
- **The Antigravity home is the attempt's HOME (agyhome-1).** Account a1's home held 665 MB of a pnpm store under
  `.local/share` after a day of attempts: state persists across attempts and Works, unlike Claude Code and Codex, which
  get a throwaway HOME.
- **A Worker is not told its context Artifacts' IDs (ctx-1).** The plan-items comparison of the DNA Batch was not a
  model failure as first read: Codex asked for the Intent's ID, found none in `in/context/context-1.json`, wrote nothing
  and said "Blocked"; Gemini Carbon wrote an invented hash; Claude Opus wrote the right one. A comparison of Runtimes
  for planning waits until the Task carries the ID.
- **Workers end without a structured result (finish-1).** The installed CLIs accept a final-result schema
  (`codex exec --output-schema` and `-o`, `agy --json-schema`) and an effort flag; System passes none. Orca drives both
  interactively and treats only the agent protocol's `end_turn` as success, so it offers the idea, not code.
- **A reopened step sees one line (reopen-1).** The reopened implement step receives the verdict, whose reason is one
  bounded line; the check-run Artifacts with the command and output tails are not in its inputs. Of 13 reopened Works
  since 2026-11-20, those that succeeded at once had a reason naming the failing test. Orca's fix loop is a prompt
  contract (two attempts, then the owner), with no log passed either.
- **The runbook is a hot spot (runbook-1).** Since 2026-11-10: 14 merge conflicts (host/src/operations.ts 4,
  host README 3, STATUS.md 2, eight of the 14 in prose files) and 7 docs-impact failures (workflow-composition.md 4,
  runbook.md 3). Since 2026-11-01 the most-changed files by distinct Items are PLAN.md 85, STATUS.md 43, runbook.md 24.
  Orca keeps per-topic reference pages and small files (a shrink-only max-lines baseline).

## Candidates not yet Items

| Candidate | Source | Note |
|---|---|---|
| Split or narrow docs/architecture/workflow-composition.md | hot spots | 4 docs-impact failures |
| Split packages/host/src/operations.ts, then packages/app/src/cli.ts | hot spots | 4 conflicts on operations.ts |
| A docs-impact preflight command for Workers, from the same resolver as the `docs` check | docsync (unverified) | structured missing-doc paths |
| Every attempt records a usage outcome (known, partial, unavailable with a reason) | cost | 11 of 41 Works had unknown cost; port Orca's Claude and Codex usage parsers |
| A Role × Runtime × Model report from Work records with Wilson intervals | evals | infra failures and conflicts outside the denominator |
| First ratchet: `as unknown as` casts in packages/*/src (8 today) may only fall | ratchet | not a size budget, so compatible with ADR-0015 |
| A held Work states the question, options and the command per option | asks | no agent may answer it (ADR-0011) |
| A check run records the Node version and path it used; a missing `checkEnv` path fails fast | worker environments | no per-run cargo directory: no failure recorded, and it would discard the cache |
| Declared write paths per Task, overlap shown before dispatch, `merge-tree` preview in the queue | conflicts | larger; after the splits show whether conflicts persist |

## Not to take

- Orca's coordinator may allow a worker's approval behind a setting (RES-0015); its decision gates resolve by run
  access, not by a person. System keeps approval human-only.
- Orca's in-session nudges and conversation resume keep an agent loop alive; System re-runs a step from its Artifacts.
