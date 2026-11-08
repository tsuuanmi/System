# Rust ACP bridge integration tests

`bridge_test.rs` runs the compiled Rust bridge against the local Node
`mock_agent.mjs`, a tiny ACP v1 fake agent. The tests exercise the **official
Rust ACP SDK** over stdio, including initialization, session setup,
successful prompt completion, permission denial and abnormal stop reasons,
without any live model account or credential.

This mock agent is solely a test fixture: do not use it for an actual
Worker and do not treat it as a complete ACP conformance suite.
