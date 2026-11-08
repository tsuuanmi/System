# ACP Worker plugin tests

- `worker.test.ts` — provider-neutral WorkerPort status/Artifact outcomes,
  cancellation, exact output capture and fail-closed permissions.
- `transport.test.ts` and `mock-agent.mjs` — real official ACP SDK v1
  handshake/prompt/denial/abort over stdio, with a local fake subprocess
  service and no model credentials.

The WorkerPort suite also exercises explicit provider environment credentials,
rejects unsafe environment variable names and refuses to spawn an ACP agent
when a required credential is missing. The Work registry suite checks that
two plugins cannot claim one WorkerRef.

Tests do not establish live Claude/Codex compatibility, sandboxing or safe
in-flight hot reload. Those remain separate release gates.
