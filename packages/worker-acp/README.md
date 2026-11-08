# @system/worker-acp — optional Cordis Worker plugin

**The ACP Worker is a plugin, not a new Work Controller or a new runtime
inside `@system/agents`.** It registers provider-neutral `WorkerPort`
instances with `@system/work` and reuses the shared TypeScript
[`worker-execution`](../worker-execution/README.md) helpers for
per-attempt Artifacts, worktree and DSH process management. The optional
Rust [ACP bridge](../acp-bridge/README.md) uses the **official ACP Rust SDK**.

The [pinned DSH ACP reuse assessment](../../docs/research/RES-0010-dsh-acp-reuse-and-worker-plugin.md)
explains why DSH's existing `dsh-acp` **server** cannot serve as this
ACP client and why the `dsh-subagent-acp` client currently requires
a DSH Agent parent/session that System intentionally does not mount.

## Lifecycle and configuration

The `worker-acp` row exists in `@system/bundle` but starts
**`disabled: true`**. A local profile patch may opt it in:

```yaml
- id: worker-acp
  disabled: false
  config:
    accounts:
      - ref: acp/research
        capabilities: [research]
        command: /absolute/path/to/system-acp-bridge
        agentCommand: /absolute/path/to/codex-acp
        agentArgs: []
        # codexHome: codex/default
        # OR tokenRef: CLAUDE_CODE_OAUTH_TOKEN
```

Run `cargo build --manifest-path packages/acp-bridge/Cargo.toml --release`
first and point `command` to the resulting executable. A real ACP-capable
agent executable must also be installed separately. No binary or Rust
compiler is required when the row is disabled. Enabling without those
executables leaves the relevant account **unavailable** in
`system workers`, not silently routed through a different provider.

Disabling the row removes its registered Worker capability. For in-flight
attempts, use a controlled **drain/restart** until hot-toggle safety is
tested: unregistration alone is not proof that the external process range
is gone. Work/Attempt state and effects stay with System.

The ACP account `ref` is stable and unique among enabled WorkerPort
providers. CLI headless workers are separately configured in
[`@system/agents`](../agents/README.md). The capability registry and
`system workers` aggregate both without depending on either plugin name.

## Contract and current limits

- ACP **v1** using Rust SDK, one session and one prompt per process. ACP
  wire messages are not implemented in TypeScript.
- System's shared helpers own exact Artifact outputs, immutable inputs,
  short-lived worktrees, bounded logs, DSH subprocess scope,
  cancellation and lost-PID checks.
- Bridge prompt is a private 0600 file; only explicit per-account
  authentication is forwarded. No process environment dump or secrets in
  stdout. A missing binary/auth reports unavailable.
- ACP permissions are denied. No automatic tool approval or new
  System publish/merge authority. **Rust is not a sandbox.**
- ACP EndTurn is not Work success without the expected Artifact outputs
  and configured verifier. Usage/token counts are **unknown** rather than 0.
- Model tiers, input-token budgets, ACP v2, interactive resume and
  automatic provider fallback are not supported. An incompatible config
  refuses registration.

## Tests

```sh
pnpm check
cargo test --manifest-path packages/acp-bridge/Cargo.toml
python3 tools/docs.py check
python3 tools/docs.py sync --check
```

No real-agent smoke, interactive permission broker, dynamic in-flight
reload guarantee, or distributable Rust binary has been demonstrated.
Keep this PR in Draft until release gates are satisfied.
