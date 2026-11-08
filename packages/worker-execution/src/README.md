# Worker execution utilities

- `workspace.ts`: materializes immutable Artifact inputs and context;
  captures exact git-tree or file Artifact outputs; cleans up worktrees.
- `process.ts`: thin typed wrapper over DSH subprocess scope, PID/exit
  reconciliation and lazy command version.

These are pure/shared utilities; the Work Controller and provider-specific
WorkerPorts remain in their own packages.
