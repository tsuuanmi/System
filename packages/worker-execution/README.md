# @system/worker-execution

**TypeScript library, not a DSH plugin.** Contains one source of truth for
System attempt workspace materialization, prompt construction, exact Artifact
capture/cleanup and DSH subprocess range/PID/version helpers.

Consumers: `@system/agents` (Claude/Codex headless and Website), and optional
`@system/worker-acp`. Nothing here registers Worker capabilities, selects an
agent, approves effects, or owns durable Work state.

The implementation was moved from `@system/agents` during the independent
ACP plugin refactor; keep behavior and Artifact IDs identical and add
regression tests before changing the shared contract.
