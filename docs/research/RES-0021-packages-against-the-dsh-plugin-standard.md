---
id: RES-0021
type: research
status: active
summary: The `packages/*` plugins measured on 2026-11-27 against the DSH plugin standard of the pinned DSH 0.2.2-rc.5 (the `dsh-doc` skill and DSH's own seam packages) - export form, Config, services, inject, and the 40 value imports between packages, edge by edge (Item plug-2).
related: [ADR-0001, ADR-0017]
---

# The packages against the DSH plugin standard (plug-2)

Item plug-2, Intent `806fd2be9bf8`. Measured on `dev` at `f976dd8` against the pinned DSH
(`engines.dsh` 0.2.2-rc.5, installed under `~/.nvm/.../@deepseek-ai/dsh/node_modules/@deepseek-ai/`). Display
metadata (locale `meta`, icon, `files`) is out of scope (operator, 2026-11-27).

## What the standard asks

From `dsh-agent-preset/skills/dsh-doc/references/host-plugin.md` and `practices.md`, and from how DSH's own packages
are built:

| # | Requirement | Source |
|---|---|---|
| S1 | A Host plugin exports one form: `apply(ctx, config)` with optional `inject` and `Config`, or a service class. | host-plugin.md, "Host plugin export forms" |
| S2 | A plugin that has configuration exports `Config`; Cordis validates the row's `config` at activation, and tools read it through `Config.listConfigs`. | host-plugin.md; `dsh-storage-domain/src/index.ts:59` |
| S3 | Every service the plugin uses is in `inject`; optional ones are injected so the plugin stays inactive without them instead of throwing. | practices.md, "Stability" |
| S4 | Plugins reach each other through services. A service's contract lives in a **seam** package: an abstract `Service` class, `declare module '@deepseek-ai/cordis' { interface Context { ... } }`, value types and pure helpers. Implementations import the seam, never each other. | `dsh-attachment` / `dsh-attachment-local`, `dsh-subprocess` / `dsh-subprocess-local`, `dsh-credentials` / `dsh-credentials-local` |
| S5 | Registrations are effects of the owning context; tunables live in `Config`. | practices.md, "Principles" 2 |

DSH ships no lint or check tool for plugins or bundles in 0.2.2-rc.5: of its 337 packages none is a linter or doc
checker; `doc-sync` named in dsh-agent-preset's README checks only that skill's generated `packages.md`. The live
check is runtime inspection (`dsh-tool-cordis`), out of scope here.

## Each plugin against S1–S3

| Plugin | S1 form | S2 `Config` export | S3 services read but not in `inject` | `ctx.get(...) as T` casts |
|---|---|---|---|---|
| agents | `name`, `inject`, `apply` | no (parses its own) | `webWorker` (optional, read at `index.ts:186`) | 6 |
| app | same | no | `agents`, `appReady`, `artifacts`, `capabilities`, `classifier`, `credentials`, `storage`, `storageDomain`, `webWorker`, `work` (`index.ts:55-272`) | 15 |
| artifacts | same | no | none | 2 |
| classifier | same | no | none | 3 |
| effects | same | no | none | 4 |
| fakes | same | no | none | 2 |
| verifiers | same | no | none | 4 |
| web-worker | same | no | none | 3 |
| work | same | no | `dshHomePath` (launcher, optional) | 4 |

- S1 is met by all nine.
- S2 is met by none: each `apply` parses its own config (zod), so Cordis neither validates the row at activation nor
  lists the schema.
- S3 is broken by `app` (ten services read lazily, none declared, so Cordis does not order or track them) and mildly by
  `agents`.
- No package declares its service in `Context` (S4's typing): 43 casts stand in for it.
- `app` imports `packages/host` by relative path into its build output (`index.ts:25-27`, "declaring @system/host here
  would change the lockfile"), outside the package graph.

## The value imports between packages (S4)

`import type` excluded: 40 import statements, 90 imported names, counted by name per edge.

| Edge | Names | What they are |
|---|---|---|
| agents → work (15) | `CONVERSATION_KIND`, `GIT_TREE_KIND`, `TASK_KIND`, `TIERS`, `pin`, `requestedTier`, `tierCapability`, `writesRepository`, `isSignedOut`, `z`; `git`, `addWorktree`, `removeWorktree`, `captureTree`; `systemPath` | contract (kinds, tiers, schemas); a git library; a home-path helper |
| app → agents (1) | `WEB_WORKER_DISABLED` | contract constant |
| app → artifacts (2) | `CLASSIFICATIONS`, `CONTENT_ID_RE` | contract |
| app → work (10) | `GIT_TREE_KIND`, `TASK_KIND`, `TERMINAL`, `parseStatus`, `parseWorkflow`, `holdDecision`; `git`, `addWorktree`, `removeWorktree`, `dshHome` | contract and pure functions; git library |
| classifier → artifacts (1), → work (5) | `contentIdSchema`, `z`, `defaultChange`, `laterPasses`, `summarize` | contract and pure functions over `WorkRecord` |
| effects → work (8) | `GIT_TREE_KIND`, `pin`, `gatedFiles`, `gatesOf`; `git`; `askVerifier`, `settleVerdict`, `putVerdict` | contract; git; the verification path, called with the store passed in |
| fakes → work (1) | `systemPath` | home-path helper |
| host → work (22) | `WorkError`, `WorkflowError`, `callerSchema`, `contentIdSchema`, `ITEM_ID`, `CLASSIFICATIONS`, `DEFAULT_QUOTA_CEILING_PERCENT`, `parseWorkflow`, `readStatus`, `itemLines`, `readyCount`, `workStatus`, `summarize`, `rangeReport`, `releasesBy`, `mergeCommitOf`, `lateChecks`, `activeCoreLines`, `directTask`, `roomOf`, `resolve`, `z` | contract plus reports over records; `host` is a library, not a plugin |
| verifiers → agents (2) | `maskValues`, `subprocessSpawner` | a redaction helper; a spawner over the `subprocess` service |
| verifiers → work (5) | `TASK_KIND`, `verifierRerunReason`; `git`, `addWorktree`, `removeWorktree` | contract; git library |
| web-worker → agents (4) | `runAttempt`, `exited`, `lazyVersion`, `mediaTypeOf` | the attempt lifecycle and helpers, given their dependencies as arguments |
| web-worker → web-driver (6) | `ChatGptWebDriver`, `Procedures`, `ProviderError`, `bindsPower`, `shippedMap`, `shippedMapProblem` | `web-driver` is a library (no Cordis entry) |
| web-worker → work (5) | `TIERS`, `requestedTier`, `tierCapability`; `addConversation`; `systemPath` | contract; a function over `Artifacts` passed in |
| work → artifacts (3) | `canonicalJson`, `contentIdSchema`, `hashDomain` | contract |

**Finding.** No edge reaches another plugin's running instance: every imported function takes its dependencies as
arguments (`addConversation(artifacts, ...)`, `askVerifier(store, ...)`, `subprocessSpawner(subprocess)`). What breaks
S4 is that each package is a plugin **and** a library at one entry: `@system/work`'s entry holds the Cordis plugin, the
contract (kinds, schemas, errors, tiers), a git library and reports, so every edge above depends on the whole of it.
`work` is the hub (71 of the 90 names come from it), and `agents` is a second library for `verifiers` and `web-worker`.

## What follows

[ADR-0017](../decisions/ADR-0017-plugin-boundaries-follow-dsh-seams.md) proposes the rule; the moves are Items after
it is accepted.
