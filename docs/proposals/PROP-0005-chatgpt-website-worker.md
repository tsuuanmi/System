---
id: PROP-0005
type: proposal
status: draft
created: 2026-11-06
summary: A Website Worker that runs a step in the operator's signed-in ChatGPT web session through Playwright, returns the answer and its cited links as Artifacts, and records each exchange as a conversation; built on the Host after milestone H's release R1.
evidence: [RES-0008]
related: [PROP-0003, PROP-0004, ADR-0004, ADR-0005, ADR-0007]
---

# Proposal: the ChatGPT Website Worker

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
   - The operator signs in once, in a visible window:
     `system workers login chatgpt-web/default`.
   - The profile is the Account's credential. Like a token, it never
     reaches other Workers.
3. **One attempt.**
   1. Open a new chat.
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

## Out of scope

- Other websites.
- Automating sign-in.
- Getting round bot checks.
- Uploading files.
- Using the ChatGPT API, which needs an API key the operator does not have.
- Codex with `--search`, the official route through the same subscription,
  stays available as a separate option.
