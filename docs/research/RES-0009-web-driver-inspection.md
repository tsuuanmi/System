---
id: RES-0009
type: research
status: active
summary: Inspect the web driver (driver.ts, ui-ops, the ChatGPT UI map) and its one caller, classify each driver method as generic, ChatGPT-specific or unused by the Runtime, and name what the generic Procedures of PLAN WW step 2 can bind to.
related: [RES-0008, ADR-0002]
---

# Web driver inspection (WW step 2, first part)

**Read at commit `c92698f`** (2026-11-08). Evidence for the design of PLAN
milestone WW step 2, not a requirement and not a proposal. File paths are
under `packages/`; `driver.ts` is `web-driver/src/driver.ts` (1,035 lines),
`chatgpt.ts` is `agents/src/chatgpt.ts`, the map is
`web-driver/ui/chatgpt-web.ui.yaml` (517 lines, `ui-map@1.6`), the engine is
`web-driver/src/ui-ops/engine.ts` (715 lines).

The Runtime's whole use of the driver is in `chatgpt.ts`: `chatGptDriver`
(`:70-82`), `checkAuth` (`:87`), `ask` (`:481`, with `conversation`,
`attachment` and `signal` only), `diagnostics` (`:523`), the `on*` hooks
(`:420-422`) and `driver.map` (`:418, :465, :491`). `chatgpt-login.ts:116-119`
uses `driver.engine(page).state('auth.signed-in')` and `authState`.

## 1. Classification of `driver.ts`

GENERIC: the same for any chat Site. CHATGPT: knowledge of ChatGPT's UI or
policy that belongs in a map. UNUSED: no Runtime caller (section 2). `*` marks
a method that mixes classes; it is counted in its dominant one, and the note
names the other part. A method that no caller reaches but that `ask` reaches
is not UNUSED.

| Method | Lines | Class | Map entries | Note |
|---|---|---|---|---|
| `escapeRegex`, `escapeRegExp` | 75, 1033-1035 | GENERIC | | Two copies of one helper. |
| `shippedMap` | 86-88 | GENERIC | | Loads the YAML and the overlay. |
| `siteErrorPage` | 98-102 | GENERIC | | A marker for a transient site error page; the message names ChatGPT. |
| `constructor` | 150-159 | GENERIC | | Origin, clocks, presets. `chatgpt.com` and the 3 s logged-out hold (`:16`) are defaults. |
| `checkAuth` | 165-187 | GENERIC | `auth.signed-in`, `auth.signed-out`, `auth.login-page`, `auth.challenge`, `site.error-page`, `composer.input` | Flow is generic; the 3 s hold before "signed out" (`:182`) is a ChatGPT policy kept in code. |
| `ask` * | 206-284 | GENERIC | `composer.clear/insert/attach/send`, `turn.user`, `turn.assistant`, `tools.*` | Orchestration of stages. ChatGPT parts: Deep research and web-search branches (`:208-210, :221-225, :257`), always off from the Runtime. |
| `reach` | 355-376 | GENERIC | `auth.*` | Goto, `checkAuth`, one reload on an error page. URL shape `/c/<id>` is ChatGPT's (`:35`). |
| `staged` | 411-421 | GENERIC | | Reports a stage to `onStage`. |
| `diagnostics` | 438-457 | GENERIC | | Structure-only DOM capture. Used. |
| `showing` | 460-462 | GENERIC | `turn.user` | Only with a bound conversation; the Runtime is always temporary. |
| `engine` | 803-816 | GENERIC | | One `UiEngine` per page. |
| `markdownOf` * | 911-935 | GENERIC | `turn.assistant.done`, `turn.assistant` | Copy-button Markdown, kept when its words match the rendered ones (`answers.ts:40-62`). The fence rebuild at `:920-931` is generic; the "live Copy drops the info string" workaround is ChatGPT's. |
| `withFencedBlocks` | 943-951 | GENERIC | | Writes backtick fences (`:1028`); the Runtime's `parseBlocks` reads backtick and tilde fences (`chatgpt.ts:103-129`). |
| `waitForAnswer` | 974-991 | GENERIC | `turn.assistant`, `turn.assistant.done`, state `turn.running` | Feeds `waitForStableCompletion` (`core/completion.ts:53`). |
| `stalled` | 994-997 | GENERIC | | Outlines the page on a stall or timeout; never retries. |
| `fencedBlocks`, `fencedText` | 1005-1031 | GENERIC | | CommonMark fence scanner and writer. |
| `selectMode` * | 290-327 | CHATGPT | `model.open`, `model.show-models`, `model.option`, `model.menu`, `model.power-status` | **Runs every turn** (`ask:223` with `wanted` undefined): opens the model menu and reads the model back for `answer.mode.model` (`chatgpt.ts:486`). The selection branches are never taken. |
| `openModelMenu`, `optionName`, `optionNames`, `effortStatus` | 330-332, 768-782 | CHATGPT | `model.menu`, `model.open`, `model.option`, `model.power-status` | Helpers of `selectMode`; also run every turn. |
| `enterMode` | 379-389 | CHATGPT | `mode.group`, `mode.select-chat`, `temporary.enable` | Chat on the home page; temporary chat. |
| `awaitModeSwitch` | 397-417 | CHATGPT | `mode.group`, `settings.modeReadyMs/modeSettleMs`, `auth.*` | Waits for the Chat/Work switch, holds its mode. |
| `ensureChat`, `pressed`, `requireChat` | 470-473, 818-829 | CHATGPT | `mode.chat`, `mode.group` | Chat is `aria-pressed="true"` on `mode.chat`. |
| `refuseWorkComposer` | 835-841 | CHATGPT | `composer.input` | Refuses an input whose `aria-label` names Work. |
| `bindingOf`, `binding` | 708-711, 758-766 | CHATGPT | | The `/c/<uuid>` URL; no-ops for a temporary chat. |
| `answerText` | 901-904 | CHATGPT | `turn.assistant` | Heading's parent (`xpath=..`), strips the `ChatGPT said:` prefix. |
| `renderedBlocks` | 954-972 | CHATGPT | `answer.code` | In-page JS reads the label from `[data-code-block]` and `[data-markdown-copy="exclude"]` (`:960`). Not in the map. |
| `identity` | 194-203 | UNUSED | network `account.me` | |
| `probeFeatures` | 338-346 | UNUSED | `tools.open`, `tools.*` | Deep research, search, image probe. |
| `open` | 349-352 | UNUSED | | `ask` calls `reach` and `enterMode` itself. |
| `pageIdle` | 465-467 | UNUSED | state `page.idle` | For a kept tab (WW step 3). |
| `snapshot`, `openConversation`, `promptText` | 480-503, 571-586, 589-593 | UNUSED | `turn.*`, `conversation.missing` | Reconciliation of a bound conversation. |
| `deleteConversation`, `deletionUnverified`, `inspectConversation` | 510-568 | UNUSED | `conversation.*`, network `conversation.delete` | Deletion, with a network allow-list (`:524-533`). |
| `researchFrames`, `researchState`, `runningAfterPrompt`, `afterPrompt`, `inlineReport`, `linksAfterPrompt`, `waitForResearch`, `reportText` | 600-706, 848-894 | UNUSED | `research.*` | Deep research. |
| `signIn` | 718-755 | UNUSED | `login.*` | Credential sign-in. |
| `selectEffort` | 785-801 | UNUSED | `model.power` | Only for a `wanted.effort`, never given. |

Totals, by method (53 in all) and by lines:

| Class | Methods | Lines |
|---|---|---|
| GENERIC | 18 | about 274 |
| CHATGPT | 15 | about 143 |
| UNUSED | 20 | about 297 |

The remaining about 320 lines are the file header, types, option interfaces
and constants (`:1-100`). By lines, about 29% of the driver is not reached by
the Runtime and about 14% is ChatGPT's UI knowledge written as code. The map's
unused entries follow the same split: `login.*`, `research.*`, `conversation.*`
(from `:60`, `:188`, `:246-335`), `tools.*`, `model.*`.

## 2. Callers of the UNUSED methods

Search: `grep -rnw <name> --include=*.ts agents verifiers test-support
../test-support ../tools` (run from `packages/`), plus the driver's own file.

| Method | Result outside `web-driver/` | Inside `driver.ts` |
|---|---|---|
| `identity` | none | none |
| `probeFeatures` | none | none |
| `open` | none (`.open(` on a driver: none) | none |
| `pageIdle` | none | none (a separate `pageIdle` in `ui-ops/site.ts:22` is only called here) |
| `snapshot` | only `snapshot` of `@system/work` in `agents/tests/agent.test.ts:17,47,71`: a different function | none |
| `deleteConversation` | none | none |
| `deletionUnverified` | none | none |
| `inspectConversation` | none | none |
| `signIn` | none | none |
| `selectEffort` | none | `selectMode:295`, only `if (wanted?.effort)`; `ask` passes `this.preset(options.mode)` (`:211`), and the Runtime sets no `mode` or `defaultMode` (`chatgpt.ts:60-71`) |
| Deep research set | none; `ask` takes them only for `options.feature === 'deep-research'` (`:208, :257`), and the Runtime never sets `feature` (`chatgpt.ts:481`) | called from `ask` and `snapshot` only |

Other consumers of the package: `agents/src/remote-login.ts:25` (a comment
about `checkSignedIn`; it calls `authState`, which calls `checkAuth`) and
`verifiers/tests/verifiers.test.ts:348` (a path list). Tests under
`web-driver/tests` (`driver.test.ts` 304 lines) exercise the UNUSED methods
against `fake-chatgpt.ts` (757 lines); they are not Runtime callers.

## 3. How the driver behaves today

A reading of `driver.ts` at the time; the code and the web-driver README now
carry the behaviour, and git has this longer reading. What sections 4 and 5
depend on:

- **Completion** is conjunctive, not ordered: no running marker (Stop), a done
  marker (Copy under every assistant turn), non-empty text unchanged for
  `stableMs`; stable text alone never completes. Stall and the hard deadline
  fail as `provider_stalled` and `timeout`. The baseline is the count of
  assistant turns before the send, so an earlier answer is not taken.
- **Chat mode** is positive only when the mode switch is present;
  `refuseWorkComposer` (an input labelled `Work`) is the only guard when the
  switch is hidden, as in a temporary view.
- **Outputs**: a rendered block with the output's label is authoritative for
  its bytes, else a fenced block of that name in the answer text (the Copy
  Markdown if its words equal the rendered text, else the rendered text).
- **Retries**: one reload of the home page on the site's error page, before
  anything is typed; no resend, and an ambiguous send is only recorded. Whether
  an Attempt is repeated is the controller's and the Workflow's.
- **A site error answer** ("This response couldn't load") was not handled by
  the code at the time (a reading, not observed live); the Runtime's
  output-block check was the only barrier.

## 4. What `ui-ops` supports for each Procedure, and the gaps

The engine (`engine.ts`) gives: `resolve`/`findIn`/`count` (one visible match
of an element with candidates, scope, frames, `cardinality`); `act` with
guards, `verify` conditions, `fallback`, `sideEffect` and the actions `click`,
`insertText`, `pasteText`, `attachText`, `clearText`, `press`, `setFiles`,
`select`; `Condition` (`visible`, `hidden`, `countIncreased`, `attr` with
`equals` or `present`, `url`, `network`, `state`, `stableTextMs`, `anyOf`,
`allOf`, `not`; `map.ts:26-32`); named `states`; `errors` rules (`on: act` or
`on: answer`); the passive `network` observer; `attachText`, `copied`,
`stall`, `drift`; `settings`. Heal is off in the Runtime.

| Procedure | Binds to (map) | Engine feature | Gap |
|---|---|---|---|
| checkAuth | states `auth.signed-in/out/login-page/challenge`, `site.error-page`; elements `composer.input`, `auth.*` | `waitFor`, `state`, `drift` | The logged-out hold time (`driver.ts:16`) is a constant; the reload-once on an error page is code. A setting would do. |
| openChat | action `temporary.enable` (verify: URL or `temporary.off`); elements `temporary.toggle`, `temporary.off` | `act` | The origin, the home URL and the conversation URL pattern (`/c/<uuid>`, `:81`) are not in the map. Whether the Site has a temporary chat at all is not declared, so there is no "required but missing" outcome. |
| ensureMode | elements `mode.group/chat/work`, action `mode.select-chat`; the check is `aria-pressed` on `mode.chat` | `act`, `attr` condition | Chat is read in code (`pressed`, `:818`). It is expressible now as a state (`attr of mode.chat, aria-pressed, equals true`), but the map has no declaration of which state is required, which forbidden, and "unknown if the switch is absent". The `Work` label guard needs an `attr` condition with a pattern (only `equals` and `present` exist). The settle hold (`awaitModeSwitch`) is code over `settings.modeReadyMs/modeSettleMs`. |
| insertInstructions | actions `composer.clear`, `composer.insert` | `act` `clearText`, `pasteText` (read-back by the engine, `readbackDiff`, `engine.ts:110`) | None found. |
| attachText | action `composer.attach`, elements `composer.attachment`, `composer.attachment-adding`, `settings.attach*` | `attachText` (`engine.ts:278-305`): text or one named chip | The element ids `composer.attachment` and `composer.attachment-adding` and the chip's `aria-label` (`:292`) are written in the engine. The transport (text, chip, file) is not declared; it is discovered and reported. |
| send | action `composer.send` (verify: network, `countIncreased turn.user`, Stop; fallback Enter); `network.conversation.post` | `act` with baselines | The 10 s wait for a new user turn is code (`driver.ts:259-266`). Accepted, rejected and unknown are not distinguished: a throw after the click counts as submitted. |
| waitForAnswer | elements `turn.assistant`, `turn.assistant.done`, `composer.stop`; state `turn.running`; `errors` | `count`, `state`, `stall`, `stableTextMs` condition; `core/completion.ts` | No precedence in the map. No Site error element or state for an answer (`site.error` is the page-level one). `errors` can carry `on: answer` but runs once, after the read. The answer container is the heading's parent by `xpath=..` in code (`:902, :956`). |
| readAnswer | elements `turn.assistant`, `turn.assistant.done` (Copy), `answer.code` | `copied`, `copiedMarkdown`, `preWrapText`, `linksIn` | The relation from a heading to its answer container, the `ChatGPT said:` prefix, and the code block's label (an in-page script over ChatGPT's attributes, `:960-966`) are code, not map. The Copy workaround for a lost info string (`:924`) is ChatGPT's. |

## 5. Conclusion

Under the binding model (`ui-map@1.7`: the map names elements, actions, states
and policy; fixed TypeScript Procedures own control flow), about 274 lines of
`driver.ts` (GENERIC) would remain as Procedure code, plus the engine and
`core`, which do not change; the 143 CHATGPT lines would be reduced to
bindings, and the 297 UNUSED lines would leave the core path. The Procedure
code that stays is `checkAuth`, `reach`, the `ask` staging, `waitForAnswer`,
`markdownOf`, the fence helpers and `diagnostics`, about 25% of today's file.
The smallest set of new map kinds, from the gaps above: (1) `site`:
origin, conversation URL pattern, and whether a temporary chat exists (and how
it is entered); (2) `modes`: the required and the forbidden mode, each as a
state, with the "unverified if the switch is absent" rule, plus an `attr`
condition that takes a pattern; (3) `answer`: the container of a turn (a
relation or an element), the prefix to strip, the finished marker, the site
error state (`on: answer` evaluated on every poll, not once), and the code
block's label element; (4) `settings` for the holds that are constants now.
Whether a Site with a different flow needs a fifth kind, an ordered list of
steps, is the question RES-0009 does not settle; it needs the second Site's
map.

## 6. Result of the hostile Site

Added after WW2-ii (2026-11-08). The question of section 5, whether the binding model
suffices or needs an ordered `steps` list, was put to an invented Site
(`web-driver/tests/fake-other.ts` and `ui/fake-other.ui.yaml`) that has no temporary chat,
no mode switch, a plain textarea, no Stop button (a status element), its error inside the
answer and its code label above the code, and to ChatGPT's own map on its fake. Both pass the
one conformance suite (`tests/conformance.ts`) through `src/procedures.ts`.

**Verdict: the bindings sufficed; no `steps` list was added.** For the hostile Site every
action is one engine action (clear, paste, send, attach) and every difference is an element,
a state or an answer field in its map: the missing temporary chat and modes are the absence of
`site.temporaryChat` and `modes`; the status element is the states `answer.running` and
`answer.finished`; the error is the state `answer.error`, looked for inside the newest answer;
the label is `answer.codeLabel`. No generic code changed for it. No flow needed a menu
followed by an option, a URL navigation or any other ordered sequence, so the question of a
fifth kind stays open only for a real Site that has one.

What the two Sites did show, each recorded here and not fixed beyond what a test required:

| Gap | Where | Handling |
|---|---|---|
| A done marker under every answer (ChatGPT's Copy), as a per-answer count | ChatGPT | A condition `countAtLeast` (the hostile Site needed none). |
| Chat is verified by its own state, but its switch is absent in a temporary chat | ChatGPT | `modes.required` is a state: Chat pressed, or `temporary.off` visible. An absent switch with neither is `unknown`. |
| The `Work` label guard on the composer (`attr` with a pattern) | ChatGPT | Closed in WW2-iii: `attr` takes `matches`; `mode.work-composer` is a forbidden mode. Conformance case `work composer`. |
| The code label before a `pre` (System 1's older form) | ChatGPT | Not covered: one label element per block, paired by order; only the live widget's header bar is bound. WW2-iii: a count that does not pair is not a failure; every label is `''` (case `plain blocks`). |
| The engine's attach Procedure names `composer.attachment`, `composer.attachment-adding` and reads a chip's `aria-label` | engine | Closed in WW2-iii: the map's `attach` names the chip, the adding element and where the label is read; the hostile Site binds a file chip labelled by its text. Conformance case `attach as chip`. |
| The action ids and the `auth.*` and `site.error-page` states are fixed names, not bindings | Procedures | By convention, checked by `bindingProblems`; not worth a schema field until a Site cannot use them. |
| `openChat` after `ensureMode` | Procedures | A page already showing an empty new chat is kept, because ChatGPT chooses Chat on its home and then toggles temporary; a load may restore another mode. |
| An unknown send on ChatGPT | its fake | Closed in WW2-iii: the fake can lose the acknowledgement (`dropSend`); the case runs on both Sites. |
| Leaked control tokens, the Copy-based Markdown and its fences | Runtime | Stay above the Procedures; `readAnswer` returns the rendered blocks and text only. |

The site error is classified first on every poll (`failed`, `retryable`), so a "This response
couldn't load" is never read as an answer, on either Site.

Still open after WW2-iii (listed, not closed): the model picker and the model read-back (the
Procedures select none; a `generic` attempt records no model), the stall clock of a wait (only
the deadline), the Copy-based Markdown, answer-level `errors` rules (`on: answer`; the Procedures
use the `answer.error` state), and the reload-once on the site's error page (the attempt does it
around `checkAuth`).
