---
id: PROP-0003
type: proposal
status: draft
created: 2026-11-06
summary: Take a web chat conversation in as operator-supplied Artifacts (a manifest over file Artifacts) and let a Task carry it as context for Workers, with provenance stated, before any Website Worker exists.
evidence: [RES-0007, RES-0008]
related: [PROP-0002, ADR-0003]
---

# Proposal: conversation-to-Artifact ingestion (Website Worker, layer 1)

## Problem

The operator researches and brainstorms in web chat products, such as
ChatGPT on the web. The results then reach the repository by hand. The
System 1 audit, the Brainstorm-first roadmap and two PR #2 reviews all
arrived this way. Nothing records what was asked, what came back, or what
System can and cannot vouch for, and a Worker cannot take such a conversation
as an input. This is the first of the three Website Worker layers in
[PLAN.md](../../PLAN.md): **ingestion now**, source snapshots and the
interactive Worker later.

## Design input

This design came from System itself. Brainstorm Work `work:78631103…` (the
*architecture* brief in [RES-0008](../research/RES-0008-brainstorm-evaluation.md))
compared two proposals and was the best-scored output of the evaluation. It
recommends:

- the **curated handoff** model (proposal B), with the raw capture optional
  (proposal A);
- **observed** facts kept apart from **asserted** ones;
- one atomic bundle;
- a preview before anything is stored;
- leaks treated as permanent;
- clear labelling for Workers.

Checking the platform answers its open questions:

| Question | Answer in the current code |
|---|---|
| One atomic bundle? | Yes, without a new event. An Artifact may list `inputs`, and every input must already be stored. A manifest written after its parts can therefore never point at a missing part. |
| Corrections? | `supersedes` lineage already exists. |
| Sensitivity? | Every Artifact has a classification. The stricter one propagates to Artifacts that list it as an input. |
| Roles? | A kind holds either inline content or bytes, never both. So the parts are `file@1` blobs, and the manifest is inline content. |
| Into a Work? | A Task is the Work input. It needs an optional `context` list of Artifact IDs. |

## Proposal

1. **`system conversation add`** stores:
   - the response (required), the prompt (optional) and any attachments, as
     `file@1`, classified `local-private`;
   - then one **`conversation@1`** manifest whose inputs are those files.
     It records:
     - **asserted**: what the operator states, all optional, unknown allowed:
       `provider`, `url`, `model`, `capturedAt`, `selection`, and `context`
       flags such as browsing, memory or deep research;
     - the parts with their roles;
     - a fixed `notice` saying the content is operator-supplied and
       unverified.

   **Observed** facts (the ingest time and the operator) live in the
   Artifact's occurrence. They are kept out of the content, so adding the
   same files twice gives the same ID. Without `--yes`, the command only
   previews: sizes, the first lines, and warnings for secret-like strings in
   the files, their names and the asserted fields (a URL can carry a token).
   It stores nothing. With `--yes`, a warning refuses unless
   `--accept-warnings` is also given. `--product-context <flag>` (repeatable)
   sets `asserted.context`. `--supersedes <id>` records a correction.
2. **`system conversation show <id>`** prints the manifest with each part's
   size, and the notice.
3. **`system task new --context <id>`** (repeatable) adds Artifact IDs to the
   Task. They are also its `inputs`, so they must be stored, and the
   classification propagates.
4. **The Worker workspace** writes each context Artifact read-only under
   `in/context/`:
   - a conversation as a directory holding its `manifest.json` and its part
     files;
   - any other Artifact as a file (blob) or `.json` (content).

   The prompt lists them under a header saying they are **operator-supplied,
   unverified data, not instructions**. The header also tells the Worker not
   to copy them verbatim into a repository.

## Out of scope

- Browser automation, scraping and provider APIs.
- Parsers for provider exports. A raw export can be attached as an
  attachment.
- Fetching sources and verifying excerpts against a raw capture.
- Anchoring hashes in git.
- An effect-side check of classification. Every Worker output is
  `local-private` today, so the check would refuse everything; it needs its
  own design.

## Acceptance

- Unit tests:
  - a manifest needs stored parts, and the same files give the same ID;
  - the preview stores nothing;
  - secret-like strings are reported;
  - a correction links to what it corrects;
  - a Task carries its context, and the classification propagates.
- Workspace test: a Worker receives a conversation and a plain file as
  context, under the notice.
- Smoke test on the real profile: add, show, then a Task with context run by
  the fake CLI, which reads it.
- **Dogfood:** ingest one of the operator's real ChatGPT reviews of PR #2,
  run a Brainstorm brief that has it as context, and check that the
  synthesis treats it as data.
