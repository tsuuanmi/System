# @system/web-driver

System 1's ChatGPT web driver, its UI map and its UI engine, ported whole
(operator's decision, 2026-11-07: System 1 already works against chatgpt.com,
so its logic is ported, not written again; [PROP-0005](../../docs/proposals/PROP-0005-chatgpt-website-worker.md) item 7).
It is a library: the `chatgpt-web` Runtime in [@system/web-worker](../web-worker/README.md)
builds one `ChatGptWebDriver` per attempt and calls `checkAuth`, `open` and
`ask`. It starts no browser (the Runtime does, with [chrome.ts](../web-worker/src/chrome.ts))
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
  [chrome.ts](../web-worker/src/chrome.ts) and [display.ts](../web-worker/src/display.ts)),
  `reconcile.ts` and `start.ts` of provider-core (only the `TurnSnapshot` type
  is kept, in `src/core/driver.ts`), the `ui-outline` schema, and System 1's
  driver specs (cut from its suite by its ADR-0084; `tests/driver.test.ts` is
  new and covers what the Runtime relies on). Imports of `@tsuuanmi/system-libs`,
  `-provider-core` and `-ui-ops` are relative paths.
- **Reports go to the attempt's log, or nowhere.** `onDrift`, `onCopyRefused`,
  `onStall` and `onReport` are wired by the Runtime (`chatGptDriver` in
  `web-worker/src/chatgpt.ts`) to the attempt's log as counts and structure;
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
  throws an `Error` whose message starts `ui-map@1.0:` and names the first schema error
  only (`(and N more)` after it), not a `SchemaError`.
  `yaml` 2.9.1 (ISC) is System 1's pin; `ajv` is the one dependency beyond it,
  needed so that the ported tests that refuse an invalid map still pass.
- **A map is code (WW6f).** A shipped map file is read and validated once, when this
  package loads in a process, and kept for that process's life: an attempt never reads
  it again, so a Host never pairs its code with another version's map (a canary run
  did, after the branch moved to `ui-map@1.7` under a Host that knew 1.6).
  `shippedMapProblem()` is the one-line reason a map did not load, if it did not: the
  `web-worker` row reports its accounts `unavailable` with it. The Host's code version
  hashes `ui/*.yaml` and `ui/*.json`, so changing a map restarts the Host as changing
  code does.
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
- **Fences without Copy (W8).** System 1 kept an answer's Markdown fences only
  when its Copy worked, and otherwise recorded the rendered text, in which a
  code block shows as its language header and its content, with no fence. The
  Runtime finds each output by its fence, so `markdownOf` now ends with
  `withFencedBlocks`: when the text has no fence line, each `answer.code`
  block (`pre code`, the header before its `pre` as the info string) is
  written as a fenced block again, in place when the text still carries it,
  else after the text. A Copy whose blocks do not pair with the page's was
  silent in System 1 (it kept the rendered text, with no `onCopyRefused`);
  that is how the real site's attempt got an unfenced answer. Still silent.
- **The live code widget (2026-11-07).** The real site renders a code block
  with no `pre`: `[data-code-block]` holds a header bar
  (`[data-markdown-copy="exclude"]`, the language) and the text in
  `[data-code-block-source] code`, now the first `answer.code` candidate. Its
  Copy keeps the fences but drops their info strings, so the copy path and
  `withFencedBlocks` share `renderedBlocks`, and a bare fence takes its
  block's header as its name. Checked on the real site: a Research Work on
  `chatgpt-web/default` was accepted with its citation found.
- **Longer fences (WW5a).** A review that holds code is answered in a
  four-backtick fence (`webPrompt` asks for a longer fence around a block with
  one inside), and System 1's three-backtick pattern paired the wrong lines.
  The copy path now reads fences by CommonMark's rule (a closing fence is as
  long as the opening one at least; a shorter one inside is content), a bare
  fence of any length takes the header's name, and a block rebuilt from the
  page gets a fence one backtick longer than any run in its body. The rendered
  text that stands in for a refused Copy is not taken for Markdown because its
  content has fence lines. Checked on the real site (2026-11-07) with a tiny
  prompt on `chatgpt-web/default`: the page showed one widget labelled
  `review`, and the copy was the bare four-backtick form.
- **Blocks as data (WW5b).** `AskResult.blocks` is the final answer's rendered
  code blocks, `{ label, code }`: the header and the raw text, rows kept. A
  widget whose raw text holds fence lines (a review with ```` ```ts ````) made
  the old guard take the text for Markdown, so `withFencedBlocks` now runs
  whenever a block's label has no fence of that name in the text, and the
  Runtime fills an output from the block that carries its name.
- **Rendered text as data (WW5d).** `AskResult.rendered` is the answer's
  rendered text as the page shows it (the research report's text for Deep
  research). The live `default` account showed `~~~~report` as paragraphs and
  its Copy escaped the Markdown (`\~`, `https\://`); a caller that finds no
  block in `text` reads the fences from `rendered`.
- **Tilde fences (WW5c).** The output contract is `~~~~<name>` ... `~~~~`: a
  backtick fence closed early by the review's own ```` ```ts ```` was accepted
  as a truncated output on the real site, and only tildes close a tilde fence.
  `fencedBlocks`, `splitAfterLastFence`, the word comparison and the
  unfenced-label guard read tilde fences beside backtick ones (a closing fence
  has the opening one's character and is at least as long); a rebuilt block is
  still written with backticks.
- **Leaked control tokens (WW6b, `ui-map@1.7`).** ChatGPT sometimes leaks a model
  control token into its visible text: a `sources` block began with `<escape>`
  inside the rendered code block (canary, 2026-11-08), and the citation check
  refused it as not JSON. The map's `answer.leakedTokens` lists such literal
  strings (ChatGPT: `["<escape>"]`; default none). The Runtime removes a listed
  token only where it sits at the very start or end of an output, repeatedly,
  never inside the content, and records it in the evidence as
  `stripped: { <output>: [token, ...] }`, one entry per removal.
- **Long prompts are pasted (WW1c).** Typing a 66 KB prompt with
  `keyboard.insertText` into ChatGPT's editor took about 5.5 min (the whole `mode`
  stage of `work:d72ce675` was 336 s). The map's `composer.insert` is now `do:
  pasteText`: the UI engine dispatches one `ClipboardEvent` `paste` holding the
  text as `text/plain` into the composer, which the editor takes as one insertion;
  an editor that leaves the event unprevented gets the text typed instead. The
  read-back check is unchanged. The insert is its own stage, `insert`, apart from
  `mode`, and the checks right before the send are part of it.
- **A prompt in two parts: "attach text" (WW1g).** On a Team workspace a 61,581-character
  paste became an attachment chip, not composer text, and the read-back failed (2 characters
  read), while on another account of the same site 69,410 characters stayed text. `ask` takes
  an `attachment` (the body); the prompt is the header, inserted and read back as before
  (`insert`), and the body is pasted after it as its own paste (`attach`). The generic
  Procedure is `UiEngine.attachText` with the action `composer.attach` (`do: attachText`: the
  same paste, no read-back); what is the Site's is in the map (`ui-map@1.6`): the elements
  `composer.attachment` (a button in `[data-composer-attachments]` whose aria-label is the
  start of the text, whitespace collapsed, and an ellipsis) and `composer.attachment-adding`
  ("Adding pasted text…"), and the settings `attachMinChars` (4000: inputs below it stay one
  part, used by the Runtime's `webPrompt`), `attachWaitMs` (30 s) and `attachLabelChars` (24).
  It accepts the composer holding header and body, or the header and exactly one new chip
  whose label starts with the body's first characters with nothing adding; at the deadline
  anything else is `ui_drift` ("still being added", or "neither the text nor one named
  attachment"), in the stage `attach`, before the pre-send checks and the send, with counts
  only. `onAttached` reports `text` or `attachment` and the chip count. The pre-send mode
  checks close the last of `insert` and `attach`. Tests on the fake page: a paste over N
  characters becomes a chip after an adding state, or stays text; a wrong label and a chip
  still adding fail before the send (they drive Chrome, so they belong to `test:web`).
- **The Chat/Work switch is awaited, never assumed (WW1).** System 1 refused at once
  when `mode.group` was not there yet ("the Chat/Work switch was not found"), which
  failed real attempts on a page that was only slow, with nothing captured. `open` now
  waits for the switch, bounded by the map's new `settings.modeReadyMs` (`ui-map@1.5`;
  15 s) and requires the mode it shows to hold for `settings.modeSettleMs`, sampled
  every poll (a site that restores its mode late changes it; a change, even one that
  comes back, starts the hold again; a mode that cannot be read does not count). The whole wait ends at the deadline, each page operation in it too (WW1h), and the
  mode is read again right before the send, after the insert. At the
  deadline the failure says what the page is: `challenge`, `signed out` (positive
  evidence only) or `mode unknown`. No selector changed: no real failing page has
  been captured, so the fix is the wait and the evidence (`diagnostics(page)`: URL,
  viewport, map version, the DOM's structure only: tags, attribute names, `role`,
  `aria-label` and `data-testid`, with every text node and every other attribute
  value, URLs included, replaced by its length, `[text:42]`, so no conversation
  text, address or token survives). `onStage` reports the stages
  (`open`, `auth`, `mode`, `insert`, `attach`, `send`, `wait`, `read`) for the Runtime's evidence
  record; `send` is only the click, so a started `send` means the prompt may be out,
  and `onSubmitted` fires once the page shows the new user turn (the confirmed case).
  The wait also polls the map's state `answer.site-error` (element `answer.error`, inside the
  newest answer only): when the site shows its own error there ("This response couldn’t load",
  WW6a; it can replace the streaming or follow it) the wait stops at once with a
  `ProviderError` (`overloaded`, `siteError`, "site error: the answer did not load
  (retryable)"). Nothing is resent or regenerated; a retry is System's `work retry`.
  A failure to find the conversation binding after the read is the `read` stage's, which is reported once.
  `ask` runs `open` as `reach` (load, sign-in) then `enterMode`; `open` is both.
- **Tests:** vitest became `node:test` and `node:assert/strict`
  (`toMatchObject` is `assert.partialDeepStrictEqual`); the assertions are the
  same.

## Generic Procedures (WW2-ii, new here)

[`src/procedures.ts`](src/procedures.ts): `checkAuth`, `openChat`, `ensureMode`,
`observeModel` (WW8a: the model and Power shown, read only, bound by the map's `model.open`/`model.close` actions and `model.power-status`/`model.selected` elements; null for a Site without them), `selectPower` (WW8b: the Power level of a tier by position, `economy` the first, `standard` the middle one, `frontier` the last, read from the status "<level>, <n> of <total>." and moved by arrow keys, verified, with the menu closed and verified closed; `bindsPower(map)` says whether the map binds the control, and a tier asked of a Site that does not is `failed`), `insertInstructions`, `attachText`, `send`, `waitForAnswer` and `readAnswer` as fixed
TypeScript control flow over the UI engine, with no Site name in it. Each returns
`{ status: 'ok' | 'failed' | 'unknown', reason?, evidence }` (counts and names, never prompt
or page text) and throws only for the caller's abort. The ChatGPT driver does not use them;
the Runtime can run an attempt through them instead of it (the account option `procedures:
generic`, WW2-iii, see the [web-worker README](../web-worker/README.md)).

- **The map binds, the code decides** (`ui-map@1.7`; 1.6 maps still load). `site` (origin,
  conversation URL pattern, `temporaryChat.action` or none), `modes` (`switch` element,
  `required` state, `forbidden` states, `select` action; none for a Site without modes),
  `answer` (`turn`, `userTurn`, `container: self|parent`, `prefix`, `running`, `done`,
  `error` state, `code`, `codeLabel`, `leakedTokens`) and `settings` for the holds that were
  constants (`signedOutHoldMs`, `sendAckMs`, `answerPollMs`, `answerStableMs`,
  `answerTimeoutMs`). By convention the states `auth.signed-in` (required),
  `auth.signed-out`, `auth.login-page`, `auth.challenge`, `site.error-page` and the actions
  `composer.clear`, `composer.insert`, `composer.send` (and `composer.attach`) keep their
  names. One new condition, `countAtLeast` (a done marker under every answer), and `attr`
  takes `matches`, a pattern over the attribute's value (ChatGPT's Work composer is the
  forbidden state `mode.work-composer`). `attach` (`chip`, `adding`, `label: aria-label|text`)
  binds the attachment chip a Site makes of a long paste; absent, the elements
  `composer.attachment` and `composer.attachment-adding` and the chip's `aria-label`.
- **Validated before a browser opens.** `loadUiMap` refuses a dangling binding (an unknown
  state, element or action, a bad regular expression); `bindingProblems(map)` lists what a
  map lacks for the Procedures, and the `Procedures` constructor throws on any.
- **Mode.** `ensureMode` verifies the required mode by its own state, held for
  `modeSettleMs`; a forbidden mode is left by `modes.select` once, else `failed`; a switch
  that never shows is `unknown`, never assumed. `send` checks the mode again and refuses
  (`rejected`) before the click.
- **Send.** `accepted` (a new user turn shows), `rejected` (nothing was sent), `unknown` (it
  may have been; nothing shows it). Nothing here sends again after `unknown`.
- **Answer.** Scope is the turn after the pre-send baseline (`send` returns it). Each poll,
  in this order: the Site's error inside the answer (`failed`, `retryable`, never an answer),
  a challenge or error page, running, the done marker (when the map has one), the text held
  for `answerStableMs`. The deadline is `unknown`. `readAnswer` returns the text, the code
  blocks as `{ label, code }` (label element paired by order; a count that does not pair gives
  every block the label `''`, so none fills an output by name, and the evidence counts the
  labels) and the outside links. Leaked tokens stay the Runtime's.
- **Conformance.** [tests/conformance.ts](tests/conformance.ts) is the contract as a suite
  that runs on any map and fake page; [tests/conformance.test.ts](tests/conformance.test.ts)
  runs it on the hostile Site ([tests/fake-other.ts](tests/fake-other.ts),
  [ui/fake-other.ui.yaml](ui/fake-other.ui.yaml)) and on ChatGPT's map and fake page. Outside the binding model today, found by the hostile Site and ChatGPT's
  map, and recorded with the verdict in
  [RES-0009](../../docs/research/RES-0009-web-driver-inspection.md#6-result-of-the-hostile-site).

## Used by the Runtime, not in System 1

- `chatGptDriver(web, note)` (in web-worker) builds the driver on one account's
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
