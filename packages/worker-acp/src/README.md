# ACP Worker plugin sources

- `index.ts`: a DSH/Cordis plugin. One enable/disable boundary, one
  provider-neutral WorkerPort registration per usable ACP Account. Uses
  existing DSH subprocess and System's capability registry.
- `worker.ts`: System Attempt/Artifact capture and policy-neutral execution
  through the existing shared worker-execution library; no ACP wire parser.
- `protocol.ts`: System-to-Rust bridge invocation and bounded structural
  event/result projection. ACP itself stays in the official Rust SDK.

This plugin cannot approve System effects or change Work identity.
