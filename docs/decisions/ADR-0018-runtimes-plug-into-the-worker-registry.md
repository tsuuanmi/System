---
id: ADR-0018
type: decision
status: accepted
date: 2026-11-28
summary: Every Runtime, CLI or web, plugs into the one Worker registry (`Capabilities` in `@system/work/contract`) and owns its Accounts in its own row; a Worker registration carries its Account's status, quota and version, and optionally sign-in and recheck, so `agents` knows no specific Runtime and `app` reads no Runtime's service; packages are renamed to GLOSSARY terms (`runtime-cli`, `runtime-web`), row ids in the one profile migration.
related: [ADR-0017, ADR-0001, RES-0021]
---

# Runtimes plug into the Worker registry

Accepted 2026-11-28 by the operator in a grilling session ("Đồng ý toàn bộ", questions Q1 and Q5 to Q9), for Intent
`806fd2be9bf8`. Acceptance does not mean the code follows it yet: the moves are Items rt-1 to rt-4.

## Context

- `agents` holds the configuration of every Account, the `web` ones too, and hands those to the `webWorker`
  service (`expect`, `register`, `announced`). To do it, it looks up a plugin named `system-web-worker` in the registry
  and waits up to 30 s for it (`packages/agents/src/index.ts:186-286`, flaky-2).
- Workers already register in one registry, `Capabilities.registerWorker` (`packages/work/src/registry.ts`). What is
  not shared is the Account view: `system workers` reads `agents.accounts()` and `agents.quota()`, and `app` calls the
  `webWorker` service for sign-in and recheck.
- GLOSSARY avoids "agent" for Runtime and Worker; the package is named `agents`.

## Decision

1. **One registry.** A Worker registration (`WorkerPort`, in `@system/work/contract` under ADR-0017) carries its
   Account's `status()`, `quota()` and optional `version()`. `system workers` reads `Capabilities`; the `agents` service
   keeps only `ask`.
2. **Runtime-specific operations are optional methods** of the registration: `signIn?` and `recheck?`. `app` calls them
   by Worker ref; a Runtime without one answers "not supported by runtime X". `app` reads no Runtime's service.
3. **Each Runtime plugin owns its Accounts** in its own row's `config` and registers its own Workers; no Runtime
   plugin reads another. Disabling a Runtime's row removes its Accounts with it.
4. **Names follow GLOSSARY and DSH's seam/implementation pattern:** `@system/agents` becomes `@system/runtime-cli`,
   `@system/web-worker` becomes `@system/runtime-web`. Row ids are configuration identity, so they change only in the
   one profile migration (rt-4), together with moving the `web` Accounts.
5. **Migration is refused, not rewritten.** A profile with `web` Accounts under the old row is refused at Host start
   with the exact lines to move; System never rewrites the operator's profile (dsh-doc `configuration.md`).

## Alternatives considered

- **A new seam package `@system/runtime`** with its own Account registry: rejected, two registries for one set of
  Workers.
- **Keep `agents` as the Account owner and let Runtimes register into it:** rejected, `agents` stays a hub and the
  CLI adapters and the registry stay one package.
- **Rename row ids at once:** rejected, the operator would edit the profile twice.

## Consequences

- Items rt-1 (registration carries the Account view), rt-2 (optional sign-in and recheck), rt-3 (package renames,
  row ids kept) run unattended; rt-4 (the profile migration: `web` Accounts move, row ids `runtime-cli` and
  `runtime-web`, the `webWorker` service and the 30 s wait deleted) waits for the operator.
- The Classifier's `ask` stays on `runtime-cli`; the Classifier is off (PLAN RB).
