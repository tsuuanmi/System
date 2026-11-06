# @system/verifiers

The `verifiers` row: two verifier capabilities on the contract of
[ADR-0003](../../docs/decisions/ADR-0003-artifact-ids-and-verification-contracts.md)
decisions 6-8 and [ADR-0004](../../docs/decisions/ADR-0004-mvp-0-operating-decisions.md)
decisions 12-13. **Injects:** `capabilities`, `artifacts`, `subprocess` (DSH).

## The contract (in `@system/work`)

A verifier has a `ref`, a `version`, the subject kinds it `accepts`, and:

- `criteria({capability, name, input})`, called **at admission**: pins the
  named criteria for that Work as an Artifact, or throws to refuse the Work.
- `verify({subject, criteria, ...})`: returns a verdict (`pass`, `fail`,
  `inconclusive`, `error`), a reason, the subject and criteria it judged, and
  stored evidence Artifact IDs.

The controller, not the verifier, stores the `verdict@1` Artifact. It turns
into `error` a verdict about another subject or other criteria, a `pass`
without evidence, unstored evidence, and a subject kind the verifier does not
accept. A verdict about a subject that has since been replaced counts as
`stale`, never as a pass.

## `code.required-checks` (version 1)

- **Accepts:** `git-tree`.
- **Criteria:** `.system/checks.yaml` read **from the task's base commit** at
  admission, stored as `checks@1`. A Worker editing that file cannot change
  the pinned checks. No file, or an invalid one, refuses admission.

```yaml
checks:
  - name: test               # [a-z][a-z0-9-]*
    run: npm ci && npm test  # run with /bin/sh -c in the checked-out commit
    timeoutSeconds: 600      # default 600, at most 3600
```

- **Verify:** check out the exact subject commit into a fresh worktree, run
  each check with a minimal environment (`PATH`, `LANG`, a throwaway `HOME`,
  `CI=1`) through the DSH subprocess service, and store one `check-run@1`
  evidence Artifact per check (exit, signal, timeout, duration, output tails).
  `pass` when every check exits 0; `fail` when any does not or times out;
  `error` when the commit cannot be checked out.

## `research.citation-check` (version 1)

- **Accepts:** `file` (the Worker's `sources` output).
- **Criteria:** `citation-criteria@1`: at least 1 source, quotes of at least
  8 characters, 20 s fetch timeout, 2 MiB per page.
- **Format:** `{"sources": [{"id", "url", "quote", "claims": [..]}]}`; the
  Research Workflow's step instructions tell the Worker this shape.
- **Verify:** fetch each URL and search its text for the quote, ignoring
  markup, scripts, entities, case and whitespace. One `citation-check@1`
  evidence Artifact records each URL's status and the hash of the bytes seen.
  `fail` for a malformed file, too few sources or too-short quotes;
  `inconclusive` when a page cannot be fetched or its quote is not found;
  `pass` when every quote is found.
- **Limit:** this checks the web **as it is at verification time**. It never
  proves what the Worker read; that needs the System `fetch` tool (MVP-1).
  Claims are not checked against quotes.

Sources: [src/checks.ts](src/checks.ts), [src/citations.ts](src/citations.ts),
[src/index.ts](src/index.ts); tests: [tests](tests/README.md).
