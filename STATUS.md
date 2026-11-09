# System status

Aim: System is a durable work control plane on DSH.

- [x] df-1 Drop Goals, decisions, the brief, the Orchestrator caller and `system mcp --goal`
- [x] df-2 The environment of the checks (`checkEnv`)
- [x] df-11 A release check checks only what changed since the running release
- [x] df-3 The status of a project: Items in STATUS.md, `system status`, one Work at a time per Item
- [x] df-4 The MCP server's `instructions`, describing the status query
- [x] df-10 `system status` reads STATUS.md from `origin/dev` when it exists, else the local `dev`, and says which and how old; a local `dev` that is behind gave "no STATUS.md on dev"
- [x] df-5 The small cuts: `Host.interrupted`, the Host pass-throughs, the twice-written `executor` and `usage` shapes, header comments that restate ADRs (done in df-9)
- [x] df-6 Drop the conversation intake (`system conversation add`) (done in df-9)
- [x] df-8 The code-write Worker runs the repository's checks before it finishes
- [x] df-9 First hygiene pass (docs under budget, small cuts, conversation intake)
- [ ] df-7 One automatic further attempt with the failure as input, declared in the Workflow (replaces DF2b), then DNA (DF2c)
- [x] df-12 `system work wait <work...> [--any]`: returns when the Works end, are held or await approval; the MCP instructions tell a session to run it in the background (notices over MCP do not wake an idle session)
- [ ] df-13 Routing takes the first capable Account with a free slot; `work report` records time waiting for a slot and rate-limited attempts (after df-14)
- [x] df-14 At most `maxConcurrentChecks` (default 2) check runs at once on the machine
- [ ] df-15 System's checks under 2 minutes: `web-canary.test.ts` moves to `test:web` (it sets smoke's 100 s), `publish.test.ts` is split so its tests run in parallel
- [x] df-16 `work.submit` over MCP runs the Work unless asked not to, as the CLI does; a Work admitted and never run shows as "admitted, not running" (not `running`) in `work list` and `system status` (a session left one pending 55 minutes)
- [x] df-17 The takeover context of an Item carries what a new Worker needs: the earlier Works' Task IDs (their instructions), their change Artifact IDs, and the failing verdict's reason and evidence IDs, not only the Work's end reason (work:4069c2a7 got none of it and changed nothing)
- [x] df-18 A `code-write` step whose change is the same tree as its base fails with "no change" instead of succeeding
- [ ] df-19 Done is derived, not ticked: an Item is done when a Work naming it was merged into `dev`, read from the Host's store; Works no longer edit STATUS.md (parallel ticks on neighbouring lines conflicted, df-15); `[x]` stays for what was done outside System; `task new --item` refuses an Item without a line, so every Worker has its description; the takeover context opens with the Item's line and marks an earlier Work that changed nothing as such
- [ ] df-21 `system work wait` on several Works exits with the worst outcome among them (failed before held before succeeded), not 0: waiting on one succeeded and one failed Work exited 0
- [ ] df-20 Compare `workflows/feature.yaml` with `software-engineering.yaml`, as the operator confirmed on 2026-11-09 (in the session that carried DF on, DF3): feature.yaml on three real Items, measured against the DF Works of software-engineering.yaml already recorded (no Item run twice, nothing thrown away). Measure tokens and time per step, rework, the implement step's input tokens, and whether the tests failed first. Run 1: df-21 (work:4fc9250c failed on an existing test the plan missed; feature.yaml then checks code before docs and the plan lists existing tests to update; work:ad01fa8a merged, implement 171k input tokens against 0.6M to 7.5M for software-engineering.yaml). Run 2: df-22 (work:e3c18974 merged in 11.6 min, no rework, 1.20M input tokens: plan 234k, tests 277k on Codex, implement 502k, docs 190k; its 3 new tests failed before implement). df-23 with software-engineering.yaml beside it (work:971987b4 merged in 13.8 min, 1.30M input tokens, one rework: its own new smoke test failed the first checks). Run 3: one Rust change in DNA, from the DNA session, which also runs DNA's Rust gates for the first time
- [ ] df-22 `system work submit --workflow <file>` resolves a Sub-workflow that is not beside the file from the Task's base commit (`workflows/`), as the Host does for MCP callers, instead of failing with ENOENT (running /tmp/hygiene.yaml needed code-checks.yaml copied beside it)
- [ ] df-23 `system workers` shows each Account's capabilities and the model of each tier, so a session can tell which roles the profile gives without reading `~/.system/profile.yml` (the DF3 session had to ask whether code.tests and code.docs were set)
