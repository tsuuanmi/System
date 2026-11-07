---
id: PROP-0005
type: proposal
status: accepted
created: 2026-11-06
summary: A Website Worker that runs a step in the operator's signed-in ChatGPT web session through Playwright, returns the answer and its cited links as Artifacts, and records each exchange as a conversation; built on the Host after milestone H's release R1.
evidence: [RES-0008]
related: [PROP-0003, PROP-0004, ADR-0004, ADR-0005, ADR-0007]
---

# Proposal: the ChatGPT Website Worker

**Status:** accepted and built (milestone W, step W1, 2026-11-07).

## Decision context

The operator does research and brainstorming in ChatGPT on the web and wants
System to use it as a Worker (operator, 2026-11-06). Three research Works
informed this proposal. Their verdicts were inconclusive because of
quote-formatting mismatches, so they are to be re-run after the verifier
fix V1; their content is used here as reference.

- `work:849abdee` (tokens and cost): not needed for this proposal.
- `work:e8677000` (existing projects): the ChatGPT-specific open-source
  drivers (chatgpt-proxy, chatgpt-mcp, chatgpt-cdp-mcp, chatgpt-web-mcp and
  chatgpt-browser-agent) are small, new and mostly **unlicensed**, and none
  extracts cited sources. General-purpose bases exist: Playwright and
  Playwright MCP, Chrome DevTools MCP, and browser-use.
- `work:179dde7d` (risks): OpenAI's Terms of Use (December 2024 text, read
  through a mirror) list "Automatically or programmatically extract data or
  Output" among the things users may not do, which puts the account at risk.
  Other risks are Cloudflare bot checks, UI changes, and a signed-in browser
  profile that must be guarded like a password. **The operator accepted these
  risks for their own account.**

Because the ChatGPT-specific drivers have no license, System does not copy
their code. It may learn from their approach, such as recognising that an
answer is complete when its copy button appears, with a content-stability
fallback.

## Proposal and what was built

1. **A third Runtime**, `chatgpt-web`, beside Claude Code and Codex, in
   `packages/agents/src/chatgpt.ts`: an Account `chatgpt-web/<name>` of the
   `agents` row (default `chatgpt-web/default`) with the capabilities
   `research`, `brainstorm.idea-*` (by role) and `web-search`. It drives the
   page with `playwright-core` 1.64.1 (Apache-2.0) on the installed Google
   Chrome, launched per attempt on the persistent profile, with no browser
   download and no ChatGPT-specific dependency. It runs in the Host: a
   browser is a long-lived resource the Host can keep between attempts.
   **Not enabled in the bundle**; the runbook says how to add it.
2. **The session.** A dedicated browser profile under
   `$DSH_HOME/system/chatgpt-web/<account>/`, owner-only and outside any
   sync, is the Account's credential and, like a token, never reaches other
   Workers. The operator signs in once with
   `system workers login chatgpt-web/<name> [--cookies <file>]`, the Host
   operation `workers.login` (`agent: false`). Without `--cookies` a visible
   window opens when the Host has a `DISPLAY`; the operator's machine has none
   (checked 2026-11-07), so login also accepts a session cookie export (JSON or
   Netscape) from the operator's own browser, read once by the CLI into the
   profile and stored nowhere else.
3. **One attempt.**
   1. Open a **temporary chat** (`https://chatgpt.com/?temporary-chat=true`),
      the Account option `temporaryChat`, on by default: the account's memory
      and history do not leak into the answer, so attempts stay independent,
      and the operator's history is not filled with Worker chats. System keeps
      the exchange as a `conversation@1`, whose manifest records whether the
      chat was temporary.
   2. Send one prompt, built as for the CLI Workers: the step and Task
      instructions, the inputs inlined as text with their names, and the
      required outputs.
   3. Wait for completion: the newest turn's copy action appears, then the
      text stays unchanged for `stable` seconds.
   4. Extract the answer as Markdown and the cited links from the DOM. Output
      slots are filled from labelled, fenced blocks the prompt asks for (such
      as `report` and `sources`); a missing block fails the attempt, as a
      missing file does today.
4. **Provenance.** Each attempt also stores the exchange as a
   `conversation@1` ([PROP-0003](PROP-0003-conversation-ingestion.md)): the
   prompt and response as parts, the conversation URL, the model label the
   page showed and the cited hrefs as the attachment `links.json`. System
   observed the exchange itself, so the producer is the Worker attempt, not
   the operator. Usage is `unknown`: the web UI shows no token counts.
5. **Limits and failure.** One attempt at a time per Account (the Host's slots,
   PROP-0004 C3) and a timeout per stage (load, send, answer). A sign-in wall,
   a CAPTCHA or an unknown page state fails the attempt with that reason and
   keeps a screenshot as partial output; it never hangs and never tries to get
   round a check. Selectors live in one versioned table, `SELECTORS`, and the
   page is read with scripts instead of Playwright's `fill`, `click` and
   `waitForSelector`, which need a Chrome newer than the 95 installed on the
   operator's machine.

## Tests and what is still to verify

A fake page with the same structure (`packages/agents/tests/fake-chatgpt`,
driven by `packages/agents/tests/chatgpt.test.ts` and `tests/chatgpt-web.test.ts`)
covers send, wait and extract, completion detection, a sign-in wall, a CAPTCHA
page, a missing output block and cancel mid-answer, deterministically and
without an account. A real run, gated by `SYSTEM_REAL_WEB=1`
(`tests/real-web.test.ts`), is a Research Work on `chatgpt-web/default` whose
sources the citation verifier checks.

**Still to verify against the real site:** whether web search, model choice
and cited sources work in a temporary chat, and whether the operator's custom
instructions apply. The selectors are those the site used when this was
written, not checked on a live page.

## Out of scope

Other websites; automating sign-in; getting round bot checks; uploading files;
the ChatGPT API, which needs an API key the operator does not have. Codex with
`--search`, the official route through the same subscription, stays available
as a separate option.
