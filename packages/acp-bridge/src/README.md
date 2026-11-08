# Rust bridge source

`main.rs` owns one-shot ACP v1 session protocol work through the official
`agent-client-protocol` SDK. It does not know Work IDs, Artifact IDs, Worker
account credentials or approval policy. Output is a small structural NDJSON
report consumed by the TypeScript WorkerPort adapter.

Do not add a second controller, agent loop, protocol parser or terminal
multiplexer here. A permission request is cancelled, not auto-approved.
Tests belong beside Rust code and in the adapter's TypeScript tests.
