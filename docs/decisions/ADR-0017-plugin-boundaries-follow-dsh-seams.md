---
id: ADR-0017
type: decision
status: proposed
date: 2026-11-27
summary: Each `@system/*` package keeps its Cordis plugin at the package entry and puts what other packages may import (types, schemas, constants, pure functions, the typed service contract) behind a `./contract` subpath export, as DSH separates a seam from its implementations; plugins export `Config`, declare every service they read in `inject`, and type services through `Context`; ESLint's `no-restricted-imports` keeps the rule, starting from today's edges and shrinking.
related: [ADR-0001, RES-0021]
---

# Plugin boundaries follow DSH's seams

**Proposed** 2026-11-27 for Item plug-3 (Intent `806fd2be9bf8`); the operator accepts or rejects it. Until then
nothing here is in force.

## Context

[RES-0021](../research/RES-0021-packages-against-the-dsh-plugin-standard.md) measured the nine plugins against the
DSH plugin standard of the pinned DSH:

- All nine use DSH's export form (`name`, `inject`, `apply`). None exports `Config`; none types its service in
  `Context` (43 `ctx.get(...) as T` casts); `app` reads ten services it does not declare in `inject`, and imports
  `packages/host` by relative path.
- 40 value import statements (90 names) cross packages. None reaches another plugin's running instance: each imported
  function takes its dependencies as arguments. The coupling is that a package's one entry is both its plugin and a
  library (the contract, a git library, reports), so `@system/work` is a hub that every package depends on whole.

DSH itself separates a **seam** (contract: abstract service, `Context` typing, value types, pure helpers) from its
implementations (`dsh-attachment` / `dsh-attachment-local`, `dsh-subprocess` / `dsh-subprocess-local`); an
implementation imports the seam, never another implementation.

## Decision

1. **Two entries per package.** The package entry (`.`) is the Cordis plugin only: `name`, `inject`, `Config`,
   `apply`. What other packages may use is exported from `./contract` (package.json `exports`): types, schemas,
   constants (Artifact kinds, tiers, errors), pure functions, and the service's interface with its
   `declare module '@deepseek-ai/cordis' { interface Context { ... } }`. A contract imports only contracts, libraries
   and DSH seams, and opens no service.
2. **Libraries** (packages with no Cordis entry: `host`, `web-driver`, and any helper split out such as git or
   worktrees) may be imported by anyone and import only contracts and libraries.
3. **No plugin-to-plugin import.** From another `@system/*` package a module imports values only from `./contract`
   or a library; `import type` from anywhere stays allowed. A plugin reaches another plugin's instance only through a
   service in `inject`; an optional one is injected with `ctx.inject` so the plugin stays inactive without it.
4. **Plugins follow S2 and S3 of RES-0021.** Each plugin with configuration exports `Config` (Cordis validates the
   row at activation); every service it reads is declared; services are typed through `Context`, so the casts go.
5. **The check.** ESLint's `no-restricted-imports` (the repository already runs ESLint in the `lint` check) forbids
   value imports of `@system/<plugin>` roots and relative paths into another package. It starts with today's
   violations listed per file and the list only shrinks; a new violation fails `lint`.

## Alternatives considered

- **Separate seam packages** (`@system/work-contract` and so on), exactly as DSH does: rejected for now. It adds
  packages and lockfile entries for what a subpath export gives; revisit if a contract needs its own version.
- **dependency-cruiser:** a standard tool for layer rules, but a new dependency; ESLint already runs.
- **TypeScript project references:** enforce the build graph between packages, not which entry is used.
- **Leave it:** today's imports are pure functions with explicit arguments, so nothing breaks at run time; but the
  hub keeps every change to `work` a change for all, and nothing stops the first real plugin-to-plugin call.

## Consequences

- Moves are Items, one cluster each (about an hour of a Worker): the lint rule with today's list first, then `work`'s
  contract, `agents`' contract (`maskValues`, `subprocessSpawner`, `runAttempt`), `Config` and `inject` per plugin, and
  `app`'s import of `host`. Each removes its entries from the list.
- Display metadata stays out (operator, 2026-11-27).
- The rule is about imports, not run time: disabling a plugin in the composition already works without it.
