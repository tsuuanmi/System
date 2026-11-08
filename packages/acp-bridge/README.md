# system-acp-bridge (Rust)

Optional **ACP v1 client bridge**, selected in
[ADR-0011](../../docs/decisions/ADR-0011-rust-acp-worker-adapter.md).
This is System's first Rust component. It delegates ACP wire handling to the
[official Rust SDK](https://github.com/agentclientprotocol/rust-sdk) (exact
`agent-client-protocol = 5.0.0` pin), not a custom ACP implementation.

**Responsibility:** initialize an external ACP-capable agent, open one session,
send one prompt, fail closed on permission requests, emit structural NDJSON and
exit. **Non-responsibility:** Work/Attempt state, approvals, effects, Git
publishing, sandboxing, Artifact capture, durable replay or agent authentication.

The TypeScript [agents WorkerPort](../agents/README.md) owns the attempt,
workspace, inputs, outputs, cancellation, process scope and logging. This
binary is opt-in, absent from the default DSH bundle.

## Build and run

```sh
cargo build --manifest-path packages/acp-bridge/Cargo.toml --release
cargo test --manifest-path packages/acp-bridge/Cargo.toml
# Diagnostic only; no real agent credential needed for --version:
packages/acp-bridge/target/release/system-acp-bridge --version
```

With an installed ACP agent executable and a text prompt at a private path:

```sh
system-acp-bridge --agent /path/to/acp-agent --args-json '[]' --prompt-file /private/prompt.txt
```

The bridge does not interpret shell strings. The prompt must be a file rather
than a CLI argument. stdout contains `acp.initialized`,
`acp.session_ready`, optional `acp.permission_denied`, and one
`acp.result` with a typed stop reason. Errors exit nonzero and details go to
stderr. The TypeScript adapter treats permission denial as an attempt failure,
even if the remote agent ignores cancellation.

**Security limitation:** permissions are deliberately denied; this bridge
cannot yet execute tasks that require additional agent-side tool permission.
The agent still runs with the OS privileges of its subprocess. There is no
safe automatic approval, permission brokerage, general sandbox or network
egress control in this PR.

## Compatibility

ACP v1 only; v2 is intentionally not enabled. Existing Claude/Codex headless
runtimes and Website Workers are unchanged by default. The official ACP
implementations [Codex](https://github.com/agentclientprotocol/codex-acp)
and [Claude Agent](https://github.com/agentclientprotocol/claude-agent-acp)
are potential *agent executables*, not Rust code to copy into System.

The Rust toolchain and upstream SDK need an installed Cargo/crates.io cache
(or normal network access) to build; no binary or `Cargo.lock` is included
in this initial source-only spike. Do not claim reproducible release status
until a lockfile, target matrix and a release pipeline are added. CI covers
compilation/unit tests where Rust is available, while core Node CI remains
independent.

## Sources and test ownership

- [`src/main.rs`](src/main.rs) — CLI and ACP v1 adapter.
- [`src/README.md`](src/README.md) — source ownership.
- [agents tests](../agents/tests/) — provider-neutral parser and invocation.
