# @system/web-driver

System 1's ChatGPT web driver, its UI map and its UI engine, ported whole
(operator's decision, 2026-11-07: System 1 already works against chatgpt.com,
so its logic is ported, not written again; [PROP-0005](../../docs/proposals/PROP-0005-chatgpt-website-worker.md) item 7).
It is a library: the `chatgpt-web` Runtime in [@system/agents](../agents/README.md)
builds one `ChatGptWebDriver` per attempt and calls `checkAuth`, `open` and
`ask`. It starts no browser (the Runtime does, with [chrome.ts](../agents/src/chrome.ts))
and holds no account, ledger or decision store.

Source: System 1, `tsuuanmi/system`, commit
`f199a277b2634f8995a499601cbf03616aa639f7`. Every ported file starts with a
line naming its source path and that commit; the code and comments are System
1's. Its history (`git log -- packages/plugins/provider-chatgpt-web
packages/ui-ops packages/plugins/browser-patchright`) and design notes
(`docs/design/browser-runtime.md`, `provider-turns.md`) were read first; every
fix in it is in the copied code and map, none was dropped.

| Here | System 1 |
|---|---|
| `src/driver.ts` | `packages/plugins/provider-chatgpt-web/src/driver.ts` |
| `ui/chatgpt-web.ui.yaml` | `packages/plugins/provider-chatgpt-web/ui/chatgpt-web.ui.yaml` |
| `src/ui-ops/*.ts` (map, locate, engine, outline, network, answers, site, heal) | `packages/ui-ops/src/*.ts` |
| `ui/ui-map.v1.json` | `schemas/ui-map.v1.json` |
| `src/core/` (`answer-text`, `completion`, `errors`, `web-turns`, driver types, `canonical`, `files`, `util`) | the parts of `packages/provider-core/src` and `packages/libs/src` that the above import |
| `tests/engine.test.ts`, `tests/heal.test.ts` | `packages/ui-ops/tests/*.spec.ts` |
| `tests/fake-chatgpt.ts` | `packages/plugins/provider-chatgpt-web/fixtures/fake-chatgpt.ts` |

What is the driver's, not the Runtime's: the sign-in states (`checkAuth`:
composer, login page, the logged-out home held 3 s, a challenge, the site's own
error page), Chat mode and the refusal of a Work composer, Temporary chat by the
page's own control, model and Power read back, the send, the wait for the
answer (finished marker and stable text, never the event stream, which stays
open), the answer as Markdown from the page's Copy, Deep research, deletion
and credential sign-in. The Runtime uses the first group; the rest is ported
and unused.

## Differences from System 1

Every behavioural difference, and why. Nothing else in the ported files
changed but the header line.

- **Not ported:** the Cordis plugin glue (`plugin.ts`, `index.ts`), the
  scheduler, ledger, gateway, accounts and vault, System 1's `Browser`,
  `Display`, registry and portable state (System has its own Host, slots,
  [chrome.ts](../agents/src/chrome.ts) and [display.ts](../agents/src/display.ts)),
  `reconcile.ts` and `start.ts` of provider-core (only the `TurnSnapshot` type
  is kept, in `src/core/driver.ts`), the `ui-outline` schema, and System 1's
  driver specs (cut from its suite by its ADR-0084; `tests/driver.test.ts` is
  new and covers what the Runtime relies on). Imports of `@tsuuanmi/system-libs`,
  `-provider-core` and `-ui-ops` are relative paths.
- **Reports go to the attempt's log, or nowhere.** `onDrift`, `onCopyRefused`,
  `onStall` and `onReport` are wired by the Runtime (`chatGptDriver` in
  `agents/src/chatgpt.ts`) to the attempt's log as counts and structure;
  `onHeal` and `beforeHealedAction` are unset and `healEnabled` is `false`:
  no decision store exists, and a heal acts without recording its decision
  (System 1's INV-13). The heal code is ported and never runs here. The local
  `overlay` is not passed (System has no overlay file).
- **UI-map validation without the schema registry.** System 1 asked its
  `SchemaRegistry` (Ajv with `ajv-formats`) for `ui-map@1.0`. `loadUiMap` here
  compiles only `ui/ui-map.v1.json` with `ajv` 8.20.0 (MIT, already in the
  lockfile through DSH) and `validateFormats: false`: **`uiRevision` is not
  checked to be a date**. The schema's one `$ref` to System 1's `common.v1.json`
  (the `capability` pattern of a rule's `feature`) is inlined. A map that fails
  throws an `Error` whose message starts `ui-map@1.0:`, not a `SchemaError`.
  `yaml` 2.9.1 (ISC) is System 1's pin; `ajv` is the one dependency beyond it,
  needed so that the ported tests that refuse an invalid map still pass.
- **`erasableSyntaxOnly`.** This repository's TypeScript runs without
  transforms, so the parameter properties of `UiEngine` and `ProviderError`
  are plain fields assigned in the constructor. Same behaviour.
- **Content addresses.** `contentId` is System 1's `libs/src/canonical.ts`,
  copied; the map's `hash` is the same value as there. (`@system/artifacts`
  has its own copy of that file, which this package does not depend on.)
- **Fixture without `otpauth`.** `tests/fake-chatgpt.ts` checks a TOTP code
  with an inline RFC 6238 function instead of the `otpauth` package (a
  dependency for one test helper). It lives in `tests/`, not `fixtures/`, so
  the root `tsconfig` checks it, and `tests/serve-fake-chatgpt.ts` (new)
  serves it from its own process for tests that block their event loop.
- **Tests:** vitest became `node:test` and `node:assert/strict`
  (`toMatchObject` is `assert.partialDeepStrictEqual`); the assertions are the
  same.

## Used by the Runtime, not in System 1

- `chatGptDriver(web, note)` (in agents) builds the driver on one account's
  clocks: `readyMs` is `timeouts.load`, `turnMs` is `timeouts.answer`,
  `stableMs` is `timeouts.stable`, and the stall clock is System 1's 3 minutes,
  or half of `answer` when that is shorter (the completion wait refuses a stall
  clock that is not shorter than the turn's).
- The page gap (`pageGapMs`), model presets and sessions of System 1's
  Browser are not used: one attempt owns its Chrome profile.
- `conversation: 'temporary'` is the Runtime's default (`temporaryChat: true`).

Tests: `corepack pnpm test` runs them; the driver tests need a headed Chrome on
a private Xvfb like the Runtime's ([test-support](../../test-support/README.md)).
The real-site test is `SYSTEM_REAL_WEB=1 node --test tests/real-web.test.ts`.
