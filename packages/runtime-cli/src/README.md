# @system/runtime-cli source

- [workspace.ts](workspace.ts) — attempt directory, inputs, prompt, output capture, cleanup.
- [adapters/](adapters/README.md) — one adapter per CLI Runtime (invocation, auth staging, parse, progress, summary, quota reader, identity) and the registry.
- [runtimes.ts](runtimes.ts) — the Runtime names, abilities and the invocation and parse types.
- [ask.ts](ask.ts) — one model turn with no tools on an economy-tier Account (`ask`), for the Classifier.
- [agent.ts](agent.ts) — one account as a `WorkerPort`, behind a `Spawner` seam.
- [index.ts](index.ts) — the Cordis row: accounts, DSH subprocess and credentials; the `web` Accounts are the runtime-web row's.
- [contract.ts](contract.ts) — what other packages import (`@system/runtime-cli/contract`, ADR-0017): the `agents` service type with its `Context` entry ([service.ts](service.ts)), `subprocessSpawner` and `lazyVersion` ([spawner.ts](spawner.ts)), and the pure helpers and types callers use.

See the [package README](../README.md).
