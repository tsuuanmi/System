---
id: ADR-0004
type: decision
status: accepted
date: 2026-11-05
summary: Fix the MVP-0 operating choices — single operator, human-only approval, external agent Workers in per-attempt worktrees, Work state in the DSH storage hub, System-owned push/PR effects, and deferred sandboxing.
related: [ADR-0001, ADR-0002, ADR-0003, ADR-0005, RES-0003, PROP-0001]
---

# MVP-0 operating decisions

## Context

[ADR-0001](ADR-0001-control-plane-on-dsh.md) to
[ADR-0003](ADR-0003-artifact-ids-and-verification-contracts.md) fix the
architecture but leave the operator model, Worker runtime, storage, effect
executor and isolation open. The [MVP contract](../requirements/mvp.md) is
broad; the first build should be the **smallest slice that proves the core
claim**: work persists, Workers change, humans govern, and two domains run
on one controller. This ADR records the choices for that slice (**MVP-0**)
and names what is deferred to **MVP-1**.

DSH facts below come from upstream `deepseek-ai/deepseek-harness` at tag
`dsh-v0.2.2-rc.1`, commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`. They
were first read at master commit `fcc0ad4`, which is 811 commits ahead of the
tag; they were rechecked at the tag on 2026-11-05: the storage, attachment and
`sdk-minimal` packages are identical, and the subagent result fields and
parent-Agent requirement are unchanged. Only the M0 boot path is reproduced by
System tests so far.

## Decision

1. **Operator.** MVP-0 has one trusted human operator. Every decision record
   carries an `operatorId` from the start, so a small team can be added later
   without a schema migration.
2. **Entry point.** A thin `system` wrapper runs `dsh --profile system "$@"`
   (DSH plugins cannot add launcher subcommands). Agents such as Claude Code
   may drive System through the same CLI. MCP is deferred.
3. **Human-only approval.** Each CLI call records whether a human or an agent
   made it. `system approve` refuses agent callers; workflow config cannot
   change this. Approval is System-owned: DSH approval only covers tool calls
   inside one DSH agent turn.
4. **Workers.** MVP-0 Workers are external coding agents — Claude Code and
   Codex CLI — run headless with no access to earlier transcripts. Worker
   interchangeability (MVP-02) is shown as a Claude Code to Codex takeover.
5. **Worker adapter.** A System-owned adapter plugin reuses DSH's subprocess
   and credential layers and the pinned agent SDKs. The stock `subagent-*`
   adapters are not used directly: their `SubagentResult` carries only
   output, structured output, diagnostic and stop reason (no usage or
   workspace changes), and every start needs a parent DSH Agent. A per-run
   `cwd` is accepted. An upstream change to carry usage and a per-run working directory
   is filed separately.
6. **Attempt execution.** Each attempt gets a fresh git worktree built from
   the exact input Artifact, a throwaway `HOME` (no SSH keys, `gh` login or
   credential helper) and an environment holding only the model API key.
   Claude Code runs with `--permission-mode acceptEdits` and `git push` / `gh`
   disallowed; Codex uses its native `workspace-write` sandbox. When the agent
   exits, the **adapter** — not the agent — snapshots the resulting tree as
   the output Artifact and reads usage from the agent's JSON output.
7. **Model credentials.** *Replaced by
   [ADR-0005](ADR-0005-subscription-tokens-for-workers.md):* Workers use
   System-held subscription tokens. (Originally: provider API keys,
   referenced by name in DSH credential config and injected per attempt.)
8. **Cancellation.** `system work cancel` sends SIGTERM to the agent's
   process group, waits 30 s, then SIGKILL. The attempt is recorded as
   `cancelled` with reason and caller; the partial tree is kept as an
   unaccepted Artifact for takeover; pending effect intents are reconciled
   before the Work becomes terminal.
9. **Work state storage.** System defines the Work, Attempt, Decision and
   Effect semantics and persists them through the DSH **storage hub** (not
   as DSH work authority): a System domain table `work`, one key per Work,
   whose value holds that Work's events, current state and effect
   intent/outcome records. Every transition is one atomic
   `update(workId, fn)`, because the hub has no multi-key transaction and
   MVP-0 needs no atomic write across Works. Artifact bytes go to the DSH
   content-addressed attachment store; artifact metadata goes to an
   append-only `artifact` table keyed by sha256. Crash tests check the SQLite
   `synchronous` level. Oversized Work values are the measured trigger for
   moving to direct `node:sqlite`.
10. **Effects.** Workers never hold git credentials. Only System's effect
    executor pushes to `system/<workId>` and opens draft PRs, recording an
    intent with an operation ID before acting and the outcome after. An
    unknown outcome is reconciled by checking whether the branch or PR exists.
    **System never merges**; merge stays a human action on GitHub.
11. **Default autonomy.** Auto-allowed: start Workers, read authorised
    Artifacts, push to `system/*`, open draft PRs. Needs approval: any other
    push, marking a PR ready for review, accepting an `inconclusive` verdict.
12. **Software Engineering verification.** The `code.required-checks`
    verifier runs pinned commands (captured at admission from the repo's
    `.system/checks.yaml` as a criteria Artifact) in a fresh worktree of the
    exact tree Artifact. The push happens only after a pass. GitHub CI may be
    added later as extra evidence.
13. **Research.** The same agent binaries, with web tools and a research
    prompt, produce `report.md` plus a structured `sources.json` (URL, quoted
    text, supported claims). Network access is unrestricted in MVP-0. The
    citation verifier fetches each cited URL itself and checks that the
    quoted text appears. Known limitation: it checks the page as it is at
    verification time, not what the agent read.
14. **Isolation deferred.** MVP-0 has no sandbox or egress control. The
    worktree, clean environment and disallowed tools are configuration, not
    enforcement; an agent running as the operator could still reach the
    network and the operator's files. MVP-04 is narrowed accordingly.
15. **DSH pin.** `@deepseek-ai/dsh@0.2.2-rc.1`, tag commit `66491b05`. All DSH
    releases are prereleases; each upgrade is its own recorded decision,
    checked against that version's upgrade guide.

## Deferred to MVP-1

- Per-attempt Docker container on an `--internal` network whose only route
  out is an allowlisting proxy, sized for about 20 concurrent Workers.
- A System `fetch` tool (MCP, in the sandbox) as the only citable evidence
  source: each fetched page stored as an Artifact and cited by ID.
- Plugin disable or reload with in-flight work (MVP failure tests 3 and 4).
- Usage checked against an independent oracle; MVP-0 records usage only.
- Cold-start, memory and service-count benchmarks.
- MCP entry point.
- Workflow schema beyond `steps`, `dependsOn`, `capabilities`, `outputs`,
  `verify` and `accept`.

## Planned after MVP-1: Website Worker

A Website Worker drives a provider's web chat UI in a browser for
brainstorming and research. It is **another Worker adapter behind the same
contract** — Artifact IDs in, a report Artifact out, verified the same way —
and must not need a controller change. It depends on the deferred sandbox and
browser automation, and web UIs give weak usage data. A `brainstorm` workflow
uses the same YAML schema; its verifier may be operator acceptance. Each
provider's terms for automated web use must be reviewed before activation.

The earlier reference implementation (`tsuuanmi/system`, commit `f199a27`)
has working `website` Workers for ChatGPT and Gemini (patchright-driven
Chrome, selector maps as data, durable reconciled turns, quota cooldowns) and
agent runtimes for the Claude Agent SDK and Codex SDK. Treat these as **reuse
candidates to evaluate**, not as System behavior or dependencies.

## Alternatives considered

- **Docker sandbox and egress proxy in MVP-0:** rejected for MVP-0 cost;
  deferred to MVP-1.
- **DSH-native model loop as a Worker:** not used; external agents better test
  whether the Worker contract leaks DSH internals.
- **Workers push with a scoped token:** rejected; effect identity and
  reconciliation must belong to System.
- **GitHub Actions as the verifier:** rejected for MVP-0; verification would
  depend on an external effect having happened.
- **One storage key per event with a head pointer:** rejected; not atomic.

## Consequences

- MVP-0 can be built and tested on one Linux host without containers.
- "Only System produces effects" holds by credential absence, not isolation;
  a misbehaving agent is not contained in MVP-0.
- Research citation checks are reproducible but not proof of what was read.
- No implementation exists yet; this ADR claims no passing tests.
