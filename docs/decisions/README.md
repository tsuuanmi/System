# Decisions

This area preserves **durable accepted or rejected architectural rationale**.
Accepted decisions explain why the current product direction was chosen;
implementation details belong in requirements and architecture. An ADR's
acceptance does not imply its code exists.

<!-- docs:begin index:decision -->
- [ADR-0001 — Control plane on DSH/Cordis](ADR-0001-control-plane-on-dsh.md) — accepted — Select System as a durable
  work control plane, DSH/Cordis as host and configurable plugin foundation, and two workflow-agnostic MVP proofs.
- [ADR-0002 — Work is the primitive; Workflow is configuration](ADR-0002-work-primitive-configured-workflows.md) —
  accepted — Make Work/Task the execution primitive and Workflow an external, versioned configuration composition of
  steps, dependencies, Worker capabilities and verification policies.
- [ADR-0003 — Artifact IDs are the handoff protocol; verification is
  pluggable](ADR-0003-artifact-ids-and-verification-contracts.md) — accepted — Require immutable Artifact-ID handoff,
  deterministic orchestration from pinned inputs and persisted decisions, and pluggable exact-subject verification
  contracts per workflow.
- [ADR-0004 — MVP-0 operating decisions](ADR-0004-mvp-0-operating-decisions.md) — superseded-in-part — Fix the MVP-0
  operating choices — single operator, human-only approval, external agent Workers in per-attempt worktrees, Work state
  in the DSH storage hub, System-owned push/PR effects, and deferred sandboxing.
- [ADR-0005 — Workers use subscription tokens, not API keys](ADR-0005-subscription-tokens-for-workers.md) — accepted —
  Workers authenticate with the operator's Claude and ChatGPT subscriptions through System-held tokens instead of
  provider API keys; this replaces ADR-0004 decision 7.
- [ADR-0006 — The MVP-0 Workflow vocabulary](ADR-0006-workflow-vocabulary-for-mvp-0.md) — accepted — Bring into MVP-0
  the Workflow fields the two domain proofs needed (inputs, version, instructions, effect, approval), which ADR-0004 had
  deferred, and record the rules that bound them.
- [ADR-0007 — One long-lived Host per machine](ADR-0007-one-long-lived-host.md) — accepted — Replace one short-lived DSH
  host per CLI command with one long-lived System Host per machine (user-systemd system.service, no socket activation),
  reached through a Unix-socket API by the CLI and by agents through an MCP adapter; independent steps run in parallel
  within per-Account limits.
- [ADR-0008 — A `dev` integration branch System may merge into](ADR-0008-dev-integration-branch.md) — accepted —
  System's own changes integrate into a `dev` branch that System may update and merge into once the required checks
  pass; only the operator merges `dev` into `main`.
- [ADR-0011 — A human caller needs a terminal](ADR-0011-human-caller-needs-a-terminal.md) — accepted — A CLI call is a
  human only at a terminal (SYSTEM_CALLER=human no longer lifts a pipe to human), and retrying a verify step asks the
  same typed confirmation as `system approve`; the human/agent boundary within one OS user stays advisory until Workers
  run as another user.
- [ADR-0012 — The Host carries Works on and never picks an Item](ADR-0012-host-carries-works-on-never-picks-items.md) —
  accepted — The Host carries admitted Works on and never picks an Item or creates a Work; picking, writing the Task and
  submitting is a caller's act (scheduled sessions included); Items stay in each repository's STATUS.md with derived
  state, and a database is reconsidered only on three stated triggers.
- [ADR-0013 — Models decide what to try; deterministic checks decide what is
  accepted](ADR-0013-models-decide-what-to-try.md) — accepted — Models decide what to try; deterministic checks decide
  what is accepted. A model may choose what to try next and may block (fail or inconclusive), never accept; every model
  decision is an Artifact; Triage v1 only writes a diagnosis and a hold recommendation; a Model check runs in shadow
  until its precision is measured.
- [ADR-0014 — Checks in tiers by event](ADR-0014-checks-in-tiers-by-event.md) — accepted — A check may name the events
  it runs on with GitHub Actions' on, so the heavy checks (upgrade, install-guide) run once per release instead of once
  per Work; accepted trade-off - a defect only those checks catch can reach dev, and system update still refuses a
  release whose checks fail.
- [ADR-0015 — Changeability is measured, not budgeted in lines](ADR-0015-changeability-is-measured-not-budgeted.md) —
  accepted — Charter 11 (stay changeable) is judged by Items merged on their first Work, the Recurring Failure Rate and
  the Time to Verified Resolution; the active core's lines are a trend recorded at each milestone and shown by work
  report, never a gate; supersedes ADR-0010.
- [ADR-0016 — The gate is enforced by reachability](ADR-0016-the-gate-is-enforced-by-reachability.md) — accepted — A CLI
  Worker and the Scheduled session run inside one bubblewrap layer as the same OS user, and the operations of the
  Operator's Authority are served on their own socket that no sandbox binds; this replaces ADR-0011's advisory boundary
  for unattended work and the Claude Code-only sandbox option.
- [ADR-0017 — Plugin boundaries follow DSH's seams](ADR-0017-plugin-boundaries-follow-dsh-seams.md) — accepted — Each
  `@system/*` package keeps its Cordis plugin at the package entry and puts what other packages may import (types,
  schemas, constants, pure functions, the typed service contract) behind a `./contract` subpath export, as DSH separates
  a seam from its implementations; plugins export `Config`, declare every service they read in `inject`, and type
  services through `Context`; ESLint's `no-restricted-imports` keeps the rule, starting from today's edges and
  shrinking.
- [ADR-0018 — Runtimes plug into the Worker registry](ADR-0018-runtimes-plug-into-the-worker-registry.md) — accepted —
  Every Runtime, CLI or web, plugs into the one Worker registry (`Capabilities` in `@system/work/contract`) and owns its
  Accounts in its own row; a Worker registration carries its Account's status, quota and version, and optionally sign-in
  and recheck, so `agents` knows no specific Runtime and `app` reads no Runtime's service; packages are renamed to
  GLOSSARY terms (`runtime-cli`, `runtime-web`), row ids in the one profile migration.
- [ADR-0019 — A Release is cut at a commit](ADR-0019-a-release-is-cut-at-a-commit.md) — accepted — A Release is cut at
  one commit of `dev` on a `release/<commit>` branch, its report is generated from records by `system release prepare`,
  the Operator may approve that exact commit so a caller session merges and installs it, and docs waivers travel as
  `Docs-Unchanged:` git trailers of the commits instead of a file cleared at each release.
- [ADR-0020 — The Scheduled session is a deterministic
  caller](ADR-0020-the-scheduled-session-is-a-deterministic-caller.md) — accepted — The Scheduled session is a
  deterministic caller driven by a Schedule, with no model in the caller's role; its passes are independent and
  re-enterable, it runs outside the bubblewrap layer, the next Attempt of a step must be able to run on any capable
  Account (so a Worker's session is never resumed), and it carries out a Release only for a commit the Operator
  approved.
<!-- docs:end index:decision -->
