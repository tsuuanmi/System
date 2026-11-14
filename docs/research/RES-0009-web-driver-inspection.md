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

## 1. Classification, callers and gaps (summary)

The tables of this reading (each of the 53 methods of `driver.ts` as GENERIC,
CHATGPT or UNUSED with its lines and map entries; the grep for callers of the
UNUSED ones; the engine's support and gaps for each Procedure) are in git
history at the commit of WW2-i; the code and the web-driver README carry the
behaviour. What sections 2 and 3 depend on:

| Class | Methods | Lines |
|---|---|---|
| GENERIC | 18 | about 274 |
| CHATGPT | 15 | about 143 |
| UNUSED | 20 | about 297 |

The remaining about 320 lines are the header, types and constants. By lines,
about 29% of the driver was not reached by the Runtime (no caller outside
`web-driver/`) and about 14% was ChatGPT's UI knowledge written as code.
`selectMode` ran every turn only to read the model back. Completion is
conjunctive (no Stop marker, a done marker, text stable for `stableMs`); chat
mode is positive only when the switch is present; one reload on the site's
error page, no resend.

## 2. Conclusion

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

## 3. Result of the hostile Site

Added after WW2-ii (2026-11-08). The question of section 2, whether the binding model
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
