# Packages

System's source packages, one pnpm workspace member each. Packages are split
only when lifecycle or configuration demands it (package guidance of the [MVP-0 plan](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/PLAN.md), historical).

- [bundle](bundle/README.md) — `@system/bundle`, the only bundle of the
  `system` DSH profile: the explicit Cordis tree.
- [artifacts](artifacts/README.md) — `@system/artifacts`, the `artifacts` row:
  immutable content-addressed Artifacts.
- [work](work/README.md) — `@system/work`, the `work` row: Work records, the
  Workflow compiler and the Work Controller.
- [git](git/README.md) — `@system/git`, a library: the safe `git` call, detached
  worktrees and exact capture of a worktree; no Cordis entry.
- [host](host/README.md) — `@system/host`, the Host's transport: JSON-RPC
  over a Unix socket, the version handshake and the caller.
- [fakes](fakes/README.md) — `@system/fakes`, a scripted Worker and verifier,
  test-only and not in the shipped bundle.
- [web-driver](web-driver/README.md) — `@system/web-driver`, System 1's ChatGPT
  web driver, its UI map and its UI engine, ported whole; the page logic of the
  `web` Runtime (used by runtime-web).
- [runtime-cli](runtime-cli/README.md) — `@system/runtime-cli`, the `runtime-cli` row: Claude Code,
  Codex and Antigravity accounts as Workers.
- [runtime-web](runtime-web/README.md) — `@system/runtime-web`, the optional,
  off-by-default `runtime-web` row: the `web` Runtime (browser, sign-in and
  remote viewer) and the browser dependencies, depended on by nothing in the core.
- [classifier](classifier/README.md) — `@system/classifier`, the optional,
  off-by-default `classifier` row: answers closed questions about an Artifact
  with an economy-tier Account, for `work report` only.
- [verifiers](verifiers/README.md) — `@system/verifiers`, the `verifiers` row:
  `code.required-checks` and `research.citation-check`.
- [effects](effects/README.md) — `@system/effects`, the `effects` row:
  `git.publish`, push and one pull request, merged only into the `mergeInto` allowlist.
- [app](app/README.md) — `@system/app`, the CLI app row: the `system` commands, a thin
  client of the Host.
