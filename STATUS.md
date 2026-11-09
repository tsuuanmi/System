# System status

Aim: System is a durable work control plane on DSH.

- [x] df-1 Drop Goals, decisions, the brief, the Orchestrator caller and `system mcp --goal`
- [x] df-2 The environment of the checks (`checkEnv`)
- [x] df-11 A release check checks only what changed since the running release
- [x] df-3 The status of a project: Items in STATUS.md, `system status`, one Work at a time per Item
- [x] df-4 The MCP server's `instructions`, describing the status query
- [x] df-5 The small cuts: `Host.interrupted`, the Host pass-throughs, the twice-written `executor` and `usage` shapes, header comments that restate ADRs (done in df-9)
- [x] df-6 Drop the conversation intake (`system conversation add`) (done in df-9)
- [x] df-8 The code-write Worker runs the repository's checks before it finishes
- [x] df-9 First hygiene pass (docs under budget, small cuts, conversation intake)
- [ ] df-7 One automatic further attempt with the failure as input, declared in the Workflow (replaces DF2b), then DNA (DF2c)
- [ ] df-12 `system work wait <work...> [--any]`: returns when the Works end, are held or await approval; the MCP instructions tell a session to run it in the background (notices over MCP do not wake an idle session)
- [ ] df-13 Routing takes the first capable Account with a free slot; `work report` records time waiting for a slot and rate-limited attempts (after df-14)
- [ ] df-14 At most `maxConcurrentChecks` (default 2) check runs at once on the machine
- [ ] df-15 System's checks under 2 minutes: `web-canary.test.ts` moves to `test:web` (it sets smoke's 100 s), `publish.test.ts` is split so its tests run in parallel
- [ ] df-16 `work.submit` over MCP runs the Work unless asked not to, as the CLI does; a Work admitted and never run shows as "admitted, not running" (not `running`) in `work list` and `system status` (a session left one pending 55 minutes)
- [ ] df-17 The takeover context of an Item carries what a new Worker needs: the earlier Works' Task IDs (their instructions), their change Artifact IDs, and the failing verdict's reason and evidence IDs, not only the Work's end reason (work:4069c2a7 got none of it and changed nothing)
- [ ] df-18 A `code-write` step whose change is the same tree as its base fails with "no change" instead of succeeding
