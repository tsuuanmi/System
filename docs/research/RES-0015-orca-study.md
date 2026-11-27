---
id: RES-0015
type: research
status: active
summary: What System can port or learn from Orca (stablyai/orca, MIT) at commit 196cf89 - nine Research Works and read-only subagent studies checked against System's dev at b0162e4; the operator's grilling of 2026-11-26 settled Antigravity Workers and Work-lifecycle Items (ag-1 to st-1).
related: [ADR-0003, ADR-0011, ADR-0015]
---

# What System can take from Orca

**Research as of 2026-11-26; evidence for a decision, not the decision.** Written by a caller session for the
operator's question "System có thể port, học hỏi logic, kiến trúc gì từ Orca". The operator's decisions are in
[Settled on 2026-11-26](#settled-on-2026-11-26); everything else here is a candidate.

Orca is an Electron "agent IDE" that runs Claude Code, Codex and other agent CLIs, with coordinator/worker
orchestration, bots fed from Slack, Linear and GitHub, automations, and multi-account quota. Studied at
`stablyai/orca@196cf89e5fc6fde04b6c5e007001fd1a1919d497` (MIT, Copyright 2026 Lovecast Inc.); about 32,600
tracked TypeScript files. Code copied from it keeps the MIT notice and that commit, as pstack's does (PLAN section 0).

## Sources

Nine Works of a repository-only variant of `workflows/research-source.yaml` (`web.search` dropped so that Codex
Accounts qualify; same verifier, `research.citation-check` with `citations-v3`), one question each, on a Task whose
base is the Orca commit above. Seven passed the citation check. Two failed it on bookkeeping only (a source
cited but missing, or listed but never cited). Their reports are used here and are marked *unverified*.

| Topic | Work | Worker | Report | Citations |
|---|---|---|---|---|
| Orchestration (tasks, dispatches, gates, recovery) | `work:c7522776-844b-5645-940a-9fa0ed64db2a` | codex/default | `sha256:ee9f9fa425e850b4facfb524b02da225122f7520a035e4fb85ba595bc14de2d0` | pass |
| Accounts and quota | `work:db35ed84-5be5-57e3-a167-b97869ab6c30` | codex/x2 | `sha256:94c48600da9f67378fcbb44487b5dce9387880865034b175097142a38a860cd2` | pass |
| Engineering process | `work:3a672ce4-a44e-5446-b302-0f8465a2a316` | codex/default | `sha256:58d14726c9a8a60234eba32f794600ff43293447cde66538978eac96765a70da` | pass |
| Worktrees to pull request | `work:32b85577-0c73-5934-b560-a02de317c306` | codex/x2 | `sha256:570784223f10b6bac16aeff187fc9c9036ee647b055f12e7580c7392495b4e61` | pass |
| Bots and evaluation harnesses | `work:a0a91e22-fe2d-549b-af12-a66dab429693` | claude-code/c4 | `sha256:125a7143a508ee5ad9704ef9489f8118f05d348e48729cf5b463282f16d02e2b` | pass |
| Launching and supervising agent CLIs | `work:a5202a84-2c9b-5215-ad9c-7c585f8469b6` | claude-code/c4 | `sha256:e8046c887b6b11e3297c83acfeead5b2f12cabc6962970fdaa8e7461ac17080a` | pass |
| Durability, recovery, update | `work:6455a2e8-69a2-5f57-9f1d-c3af5cc88ba4` | claude-code/default | `sha256:29af2ffe4a4208af1b3dfccb88a37822f2809f1a1e6611db32bb422a87457d8d` | pass |
| Automations, skills, plugins | `work:a5920959-4a14-5d7f-993a-b111ff62b9df` | claude-code/default | `sha256:6344c312a1b9b64c31d43b666ca72a8fd1a9e6f80bef556290864ceb33257cff` | fail (unverified) |
| Remote hosts, credentials, authority | `work:afd8bdd1-b5c3-5402-8e96-933f1354602b` | claude-code/c3 | `sha256:d084e5eef453f97cffa8da2c34a5ca149828f5ab3773acc6a6ee1f3ec8de3170` | fail (unverified) |

Five read-only subagent studies (economy tier, no citation check, file and line references only), stored as
Artifacts (docs and design review is in [Docs and review](#docs-and-review)):
CLI and MCP surface `sha256:139aaf9dae8f20e693cbab9a5503a964fe2d45db02718258c81d5f8fb0dd4d77`; conversations and
memory `sha256:47d3f2ddef4b3591aafeb7eaf31d5fed5e77c5e0e487d24120c66e539c364001`; attention and mobile
`sha256:b7ec53ac5bd71b5ad84f83de2a705065f8c97db0f73ab9412d0003dc1dda206b`; git history
`sha256:5c23113046fb9c3ee6faa1bf30ff6754f51a74fb38911c07a18709a32d8efad6`.

**Limits.** The Works' briefs described lim-1 and mcp-1 as open, from STATUS.md's checkboxes; `system status` reads
them as done. Every recommendation below was therefore checked against System's code at `dev` `b0162e4`, and those
System already has are listed as such, not proposed. The caller session spot-checked the files behind the main
candidates (`claude-limit-line.ts`, `plugin-content-hash.ts`, `ephemeral-vm-recipe-env.ts`, `ratchet-baseline.mjs`,
`worker-approval-access.ts`, `operation_unknown`); nothing in Orca was run.

## What Orca is, in System's terms

- **No agent loop of its own.** A bot is Claude Code or Codex with a preamble and the `orca` CLI as its tools
  (Bots report). Same stance as System.
- **No verification bound to an artifact.** "Tested pull request" means the worker's own tests and CI read by
  `gh pr view`; a completed task is a worker's free-text report (Bots, Orchestration). System's Verifier bound to an
  Artifact ID and its merge queue are stronger; nothing to take there.
- **No agent sandbox.** Remote means another machine, VM, WSL distro or paired host; the agent runs as that user and
  can reach the Secret Service over D-Bus (Remote report, unverified). System's deferred bubblewrap design is
  original work; Orca has nothing to port for it.
- **Mutable handoff.** Conversation context moves as text at a per-chat temporary path; Orca's "artifact" is a
  mutable, expiring shared document (Conversations, Automations). The opposite of ADR-0003.
- **Strong on control-channel identity and uncertainty.** Request receipts that answer `operation_unknown` after a
  restart instead of re-running, explicit `start_unknown`/`stop_unknown` worker states, generation fencing of late
  results, and caller identity taken from the transport (Orchestration, CLI/MCP, Remote).
- **Process for a large agent-built codebase.** About 300 commits a day over the 8 sampled days, 27% with agent
  trailers, 0.6% reverts, most within two days; a cached changed-paths gate and about 40 ratchets whose baselines only
  shrink (max-lines baseline 347 to 8 lines in three months) (History, Process).

## Already in System (not proposed)

| Orca mechanism | System today |
|---|---|
| Refuse a reused request ID with different arguments | `packages/work/src/host.ts` refuses a `commandId` used with different arguments |
| Codex quota from `codex app-server` `account/rateLimits/read`, windows told by length | `packages/agents/src/quota.ts`, gated on verified Codex versions |
| An Account whose quota is unreadable is a last resort, chosen only when no readable Account is under its Ceiling | `rankByHeadroom` in `packages/work/src/headroom.ts` |
| Output Artifact, step transition and notification in one record append | `observeWorker` in `packages/work/src/controller.ts` |
| Claude "You've hit your … limit · resets …" parsing | lim-1, done |
| Reconnect of `system mcp` after a Host restart | mcp-1, done |
| Environment doctor with remediation | `packages/app/src/doctor.ts` |
| A release current only after its install check | `packages/app/src/pending-install-check.ts` (upd-1) |
| Worker environment from an allow-list, throwaway HOME | `baseEnv` in `packages/agents/src/runtimes.ts` |
| Wilson interval for evaluation reports | `packages/classifier/src/eval.ts` |

## Candidates

Verdicts: **PORT** copies or adapts code with attribution; **LEARN** takes the idea only. Each is sized for one
Worker attempt. Candidates 1, 2 and 7 were settled as Items (see below); the rest are not.

| # | Candidate | Verdict | Orca source | Gap in System |
|---|---|---|---|---|
| 1 | Verify Codex 0.171's `account/rateLimits/read` answer from a captured response and add the version to the verified list; an answer with no usable window stays unreadable | LEARN | `src/main/codex-usage`, `codex-cli` (Quota) | every unpinned Work skips both Codex Accounts: "quota unreadable … 0.171.0 is not verified" (this study's own routing) |
| 2 | Process identity: record pid, process group and start time when a Worker CLI spawns; a later Host treats a pid whose start time differs as exited and signals only a matching group | PORT idea | `provider-group-orphan-guard.ts`, the supervisor journal (Launch) | `exited()` in `packages/agents/src/agent.ts` reads a reused pid as alive |
| 3 | Ratchet with a checked-in baseline that may only shrink, for one debt measure (for example files over a line budget), as a check in `.system/checks.yaml` | PORT | `config/scripts/static-analysis/ratchet-baseline/ratchet-baseline.mjs` (Process, History) | growth is recorded as a trend (ADR-0015) but nothing stops a single change from adding debt |
| 4 | `nextSteps` in a Host error's data, printed as `Next step:` lines by the CLI and returned through MCP | PORT idea | `cli-error.ts` (CLI/MCP) | refusals carry prose only; a caller session must infer the command |
| 5 | Content hash of a Workflow directory (sorted path and bytes, symlinks refused, size caps) recorded at admission beside `fileHash` | PORT | `src/main/plugins/artifacts/plugin-content-hash.ts` (Automations, unverified) | Sub-workflows read from disk are joined into the pinned spec, but the directory as read has no single ID |
| 6 | CLI flag floors: a per-Runtime table of flag to first CLI version; `--version` unknown still launches, too old is an Outside failure | LEARN | `agent-cli-model-requirements.json`, `claude-cli-flag-support.ts` (Launch) | only quota reading is version-gated; a flag a CLI does not know fails the attempt as a failure of the change |
| 7 | An explicit uncertain state for a Worker launch or stop that a restart interrupted (`start_unknown`), never a fresh start and never counted against the change | LEARN | `src/main/runtime` worker states, mutation receipts (Orchestration) | to check against the controller's lost-attempt path before writing an Item |
| 8 | A suspended machine is not a stalled attempt: subtract suspend time from quiet seconds | LEARN | `src/main/hang-watchdog` (Launch) | `live.quietSeconds` counts wall time |
| 9 | Missed-run grace for the scheduled session: a run that starts too late records "missed" instead of running late or silently | LEARN | `runScheduledOccurrence` (Automations, unverified) | systemd timers decide; the session records nothing when skipped |
| 10 | Worker cost from transcripts: Codex cumulative `total_token_usage` turned into per-turn deltas; Claude usage deduplicated by message ID (Orca's own Claude sum does not dedupe) | PORT (Codex), LEARN | `session-scanner-codex-parser.ts` (Conversations) | to compare with what the Runtime summaries already count (tool-1) |

## Settled on 2026-11-26

The operator grilled the candidates with a caller session and settled Intent
`sha256:2cb5277823f2c14955ec1a1c94e0bb7b0cef24cedd57c6a1206f88368bc95345` (Antigravity Workers, and what System learns
from Orca to run many Accounts and a Work's lifecycle). Its Items are ag-1, q-1, ag-2, ag-3, pid-1, qw-1, idle-1 and
st-1 in [STATUS.md](../../STATUS.md); GLOSSARY gained Quota wait and Idle, and Provider now names who holds an Account's
quota. Three further studies fed it: Antigravity CLI facts
(`sha256:9038baf7f7ecd52be42e0a48961918c1a12e96d6c7b77779d08f4f869dade15f`), the DSH plugin
[V1ki/dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions) at `407256c`
(`sha256:13e392f5ead1d4daa29dd81959a76a08ba0db7b83d7974dbfb107b9ab80283f9`), and an audit of System's Work lifecycle
against Orca's mechanisms (`sha256:da5af11f1b928f8bbbbc0b913757558c53d51e69a975a2472de369f362b72479`), all unverified.

- **Antigravity.** `agy` 1.4.6 on this machine has headless `-p` with `stream-json`, `--mode`, `--sandbox` and
  `--model`, but not the per-home flags Orca passes (`--gemini-dir`, `--app-data-dir`); its quota answer
  (`/usage`: buckets with `remaining_fraction` and `reset_time`, 5h and weekly) fits Headroom. Hence a spike first.
- **Quota reading.** The plugin reads private provider HTTP endpoints with the stored OAuth token, imitates the
  CLIs' user agents and writes rotated tokens back; its Antigravity reader is off by default for terms-of-service
  reasons. Not taken. The lesson taken is that Codex 0.171 is unreadable because System gates on a CLI version string,
  so q-1 gates on the answer's shape instead.
- **Lifecycle.** System lacks a recorded quota wait (it lives only in `live`), any Idle signal, and process identity
  beyond the pid; Orca's auto-scheduler is retired (`coordinator-start` refuses), which supports ADR-0012.

## Not to take

- **An agent that approves.** With `coordinatorApprovalsEnabled`, a coordinator agent may allow a worker's approval
  request; only prompts marked person-only are protected (`worker-approval-access.ts`; Attention). This contradicts
  "only a human approves" ([ADR-0011](../decisions/ADR-0011-human-caller-needs-a-terminal.md)).
- **Approval by channel.** Slack answers are authorized by the connector link, not the person; phone answers are a
  second approval channel (Attention).
- **Completion by report, failure counts against the task.** A worker's `worker_done` text settles a task, and a lost
  worker counts towards a circuit breaker (Orchestration). System keeps verdicts on Artifacts and infrastructure loss
  as an Outside failure.
- **Model-written memory, mutable handoff paths, Orca Cloud relay, webhooks, marketplace and kill list, Electron
  hang watchdog, renderer validation.** Each conflicts with deterministic replay, ADR-0003, or the single Host, or
  serves a desktop product.
- **Tests as the exception.** Orca commits a test only for costly regressions (Process). System's Charter 12 keeps
  "every behaviour change comes with a test that failed first"; Orca's criteria for a *good* test (real code,
  hard-coded expectations, fails when reverted, no mock-call asserts) are compatible and already System's practice.

## Docs and review

From the docs study (`sha256:199a9f1e3f409fa1e6d620c5dd4687e59405340c95910386145a75973365fe84`, unverified).
System's `tools/docs.py` already covers broken links, reachability and typed edges, so those are not proposed.

- **Reviews pin what they read.** Orca's design reviews (`docs/*-review.md`) open with the verdict, name the
  reviewed head commit, grade findings P0 to P2 and list what was not verified. LEARN: the same header fits a review
  Artifact.
- **Code paths in docs go stale.** 25 of 52 backticked repository paths under Orca's `docs/` no longer resolve,
  mostly after file moves. Candidate 11: a report-only `docs.py` rule that a backticked path which looks like a
  repository file exists at the checked commit (PORT idea).
- **Schemas from code.** Plugin JSON Schemas are generated from Zod with versioned names and `$id`; no CI check
  compares them with a fresh generation. Matches cls-1's "one source of truth" rule; the lesson is the missing check.
- **Short AGENTS.md.** About 60 lines of rules plus conditional "read before changing X" pointers; one purge
  (`16cd1e0c757`, 2026-10-07) deleted 64 reference pages. No change proposed: System's AGENTS.md has the same shape.
