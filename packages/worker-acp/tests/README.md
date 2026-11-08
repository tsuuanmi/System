# ACP Worker plugin tests

`worker.test.ts` proves the independent WorkerPort adapter's structural ACP
result handling, Artifact capture, denied permission, cancellation, and minimal
environment without a live agent subscription. The official Rust SDK's ACP
wire conformance tests remain in `../acp-bridge/tests/`.

System profile smoke tests cover the default-disabled plugin row.
