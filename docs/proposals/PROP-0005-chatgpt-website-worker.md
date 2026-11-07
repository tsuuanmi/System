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
- `work:e8677000` (existing projects).
  - The ChatGPT-specific open-source drivers are small, new and mostly
    **unlicensed**: chatgpt-proxy, chatgpt-mcp, chatgpt-cdp-mcp,
    chatgpt-web-mcp and chatgpt-browser-agent.
  - None of them extracts cited sources.
  - General-purpose bases exist: Playwright and Playwright MCP, Chrome
    DevTools MCP, and browser-use.
- `work:179dde7d` (risks).
  - OpenAI's Terms of Use (December 2024 text, read through a mirror) list
    "Automatically or programmatically extract data or Output" among the
    things users may not do. That puts the account at risk.
  - Other risks: Cloudflare bot checks, UI changes, and a signed-in browser
    profile that must be guarded like a password.
  - **The operator accepted these risks for their own account.**

Because the ChatGPT-specific drivers have no license, System does not copy
their code. It may learn from their approach, such as recognising that an
answer is complete when its copy button appears, with a content-stability
fallback.

## Proposal

1. **A third Runtime**, `chatgpt-web`, beside Claude Code and Codex.
   - It is in `@system/agents`, and its Account is
     `chatgpt-web/default`.
   - It offers the capabilities `research`, `brainstorm.idea-*` (by role) and
     `web-search`.
   - It drives the page with the **Playwright** library (Apache-2.0)
     through the system's Chromium.
   - It adds no ChatGPT-specific dependency.
2. **The session.**
   - The browser profile is dedicated, under
     `$DSH_HOME/system/chatgpt-web/<account>/`, with owner-only permissions
     and outside any sync.
   - The operator signs in once:
     `system workers login chatgpt-web/default`. Where a display exists, a
     visible window opens. The operator's machine has no display (checked
     2026-11-07), so login also accepts **a session cookie export** from the
     operator's own browser (`--cookies <file>`, JSON or Netscape format). The
     file is read once into the profile and never stored elsewhere.
   - Pinned dependency: `playwright-core` 1.64.1 (Apache-2.0), driving the
     installed Google Chrome. No browser download.
   - The profile is the Account's credential. Like a token, it never
     reaches other Workers.
3. **One attempt.**
   1. Open a new **temporary chat** (`https://chatgpt.com/?temporary-chat=true`).
      This is an Account option, `temporaryChat`, on by default:
      - the account's memory and history do not leak into the answer, which
        keeps attempts independent;
      - the operator's chat history is not filled with Worker chats.
      System keeps the exchange itself as a `conversation@1`, so the
      temporary chat's URL is not needed afterwards. The manifest records
      whether the chat was temporary.
      **To verify when building:**
      - whether web search, model choice and cited sources all work in a
        temporary chat;
      - whether the operator's custom instructions still apply.
   2. Send one prompt, built as for the CLI Workers: the step and Task
      instructions, the inputs inlined as text with their names, and the
      required outputs.
   3. Wait for completion: the newest turn's copy action appears, then the
      text stays unchanged for a short time.
   4. Extract the answer as Markdown, and the cited links from the DOM.
   - Output slots are filled from labelled, fenced blocks the prompt asks
     for, such as `report` and `sources`. A missing block fails the
     attempt, as a missing file does today.
4. **Provenance.**
   - Each attempt also stores the exchange as a `conversation@1`
     ([PROP-0003](PROP-0003-conversation-ingestion.md)): the prompt and the
     response as parts, the conversation URL and the model label the page
     showed.
   - Here System itself observed the exchange, so the manifest records the
     producer as the Worker attempt, not the operator.
   - Usage is `unknown`, because the web UI shows no token counts.
5. **Limits and failure.**
   - One attempt at a time per Account (the Host's slots, PROP-0004 C3).
   - A timeout per stage: load, send, answer.
   - A sign-in wall, a CAPTCHA or an unknown page state fails the attempt
     with that reason, and keeps a screenshot as partial output. It never
     hangs, and it never tries to get round a check.
   - Selectors live in one versioned table, so a UI change is a small,
     visible fix.
6. **Where it runs.** On the Host, after release R1 of milestone H. A browser
   is a long-lived resource the Host can keep between attempts, while a
   one-host-per-command process would launch and tear it down every time.

## Tests

- A local fake page with the same structure, served by the test, is used
  for:
  - send, wait and extract;
  - completion detection;
  - a sign-in wall;
  - a CAPTCHA page;
  - a missing output block;
  - cancel mid-answer.
  These tests are deterministic and need no account.
- A real run, gated like `SYSTEM_REAL_AGENTS`: a Research Work on
  `chatgpt-web/default`, with its sources checked by the citation verifier.

## Built

- **Runtime:** `packages/agents/src/chatgpt.ts`, an Account `chatgpt-web/<name>`
  of the `agents` row. It runs in the Host, launches Chrome through
  `playwright-core` 1.64.1 per attempt on the persistent profile, and keeps
  everything proposed above: temporary chat by default, one prompt with the
  inputs inlined, completion by the copy action plus `stable` seconds of
  unchanged text, Markdown and link extraction, slots from labelled fenced
  blocks, a `conversation@1` (producer: the Worker; the cited hrefs as the
  attachment `links.json`), usage unknown, a timeout per stage, and a
  screenshot as partial output on a sign-in wall, a challenge or an unknown
  page.
- **Login:** `system workers login chatgpt-web/<name> [--cookies <file>]`, the
  Host operation `workers.login` (`agent: false`). The cookie file is read once
  by the CLI. Without it a visible window opens when the Host has a `DISPLAY`.
- **Selectors:** one versioned table, `SELECTORS`. The page is read with
  scripts instead of Playwright's `fill`, `click` and `waitForSelector`,
  which need a Chrome newer than the 95 installed on the operator's machine.
- **Not enabled in the bundle.** The runbook says how to add the account.
- **Still to verify against the real site:** whether web search, model choice
  and cited sources work in a temporary chat, and whether the operator's custom
  instructions apply, as listed above. The
  selectors are those the site used when this was written, not checked on a
  live page. `tests/real-web.test.ts` (`SYSTEM_REAL_WEB=1`) is the check.
- **Tests:** a fake page in `packages/agents/tests/fake-chatgpt`, driven by
  `packages/agents/tests/chatgpt.test.ts` and `tests/chatgpt-web.test.ts`.

## Out of scope

- Other websites.
- Automating sign-in.
- Getting round bot checks.
- Uploading files.
- Using the ChatGPT API, which needs an API key the operator does not have.
- Codex with `--search`, the official route through the same subscription,
  stays available as a separate option.
