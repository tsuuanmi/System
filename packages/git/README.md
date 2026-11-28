# @system/git

A library (ADR-0017 decision 2), not a Cordis plugin: it has no `apply`, no
`Config` and no row in the bundle. [work](../work/README.md), [agents](../runtime-cli/README.md),
[app](../app/README.md), [effects](../effects/README.md) and [verifiers](../verifiers/README.md) import it.

- `git(dir, args, env?, timeoutMs?)` runs git with no hooks, no signing and no prompt, and a
  minimal environment; a failure names the command and directory.
- `addWorktree` checks a commit out, detached, into a new worktree; `removeWorktree` removes it.
- `captureTree` records everything in a worktree (ignored files excepted) as one commit on a base;
  an unchanged worktree is the base itself.

Snapshotting a ref, pinning a commit and the fetch checks stay in [work](../work/src/git.ts):
they use its kinds and errors.
