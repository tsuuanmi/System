# Packages

System's source packages, one pnpm workspace member each. Packages are split
only when lifecycle or configuration demands it (the [MVP-0 plan](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/PLAN.md) package guidance).

- [bundle](bundle/README.md) — `@system/bundle`, the only bundle of the
  `system` DSH profile: the explicit Cordis tree.
- [artifacts](artifacts/README.md) — `@system/artifacts`, the `artifacts` row:
  immutable content-addressed Artifacts.
- [work](work/README.md) — `@system/work`, the `work` row: Work records, the
  Workflow compiler and the Work Controller.
- [host](host/README.md) — `@system/host`, the Host's transport: JSON-RPC
  over a Unix socket, the version handshake and the caller.
- [fakes](fakes/README.md) — `@system/fakes`, a scripted Worker and verifier,
  off by default.
- [web-driver](web-driver/README.md) — `@system/web-driver`, System 1's ChatGPT
  web driver, its UI map and its UI engine, ported whole; the page logic of the
  `chatgpt-web` Runtime (used by web-worker).
- [agents](agents/README.md) — `@system/agents`, the `agents` row: Claude Code
  and Codex accounts as Workers, and the seam to the web Runtime.
- [web-worker](web-worker/README.md) — `@system/web-worker`, the optional,
  off-by-default `web-worker` row: the `chatgpt-web` Runtime (browser, sign-in and
  remote viewer) and the browser dependencies, depended on by nothing in the core.
- [verifiers](verifiers/README.md) — `@system/verifiers`, the `verifiers` row:
  `code.required-checks` and `research.citation-check`.
- [effects](effects/README.md) — `@system/effects`, the `effects` row:
  `git.publish`, push and one pull request, merged only into the `mergeInto` allowlist.
- [app](app/README.md) — `@system/app`, the CLI app row (`system doctor`,
  `system artifact`, `system work`).
