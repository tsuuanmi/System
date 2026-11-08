# ACP Worker plugin sources

- \`index.ts\` — Cordis plugin registration, explicit agent account config,
  provider-neutral WorkerPort status, and enable/disable lifecycle.
- \`worker.ts\` — System-owned Work/Attempt request-to-Artifact result mapping,
  credential isolation and output capture (using worker-execution).
- \`transport.ts\` — official ACP TypeScript SDK v1 client over bidirectional
  DSH-managed subprocess pipes: session negotiation, stream updates, reject
  permissions, cancellation, and process-range cleanup.

This package never owns durable Work, approval, verification or effects.
