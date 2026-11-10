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

- **Accepts:** `git-tree`, and a `task` (`code-checks.yaml` on its own), whose base commit is checked as it is.
- **Criteria:** `.system/checks.yaml` read **from the task's base commit** at
  admission, stored as `checks@1`. A Worker editing that file cannot change
  the pinned checks. No file, or an invalid one, refuses admission.

```yaml
checks:
  - name: test               # [a-z][a-z0-9-]*
    run: npm ci && npm test  # run with /bin/sh -c in the checked-out commit
    timeoutSeconds: 600      # default 600, at most 3600
    paths: [src/**, package.json]  # optional globs: run only when the change touches one
    red: fail                # optional, for red-v1 below: pass or fail (the default)
```

- **Verify:** check out the exact subject commit into a fresh worktree, run
  each check with a minimal environment (`PATH`, `LANG`, a throwaway `HOME`,
  `CI=1`) through the DSH subprocess service, and store one `check-run@1`
  evidence Artifact per check (exit, signal, timeout, duration, output tails).
  The checks run in order in that one worktree with one `HOME`, so a later
  check reuses what an earlier one built (`install` and `build` once, not per
  check); name one check per part so a failure says which part failed.
  A check that leaves an Xvfb or Chrome running fails, naming it (`left running:
  Xvfb pid 123`, also in the `check-run@1`'s `leftovers`): after each check the
  processes of this user named Xvfb or Chrome whose environment has the check's
  `HOME` are killed. Leaked ones hold a Worker's pipes and profile (2026-11-07).
  The row's optional config `checkEnv` (name to value, names `^[A-Z_][A-Z0-9_]*$`, never `HOME`, `PATH` or `CI`: refused) adds variables such as `RUSTUP_HOME` to every check; each `check-run@1` records the names, never the values ([runbook](../../docs/operations/runbook.md)). The row's `maxConcurrentChecks` (default 2) limits the runs at once on the machine, as the Host's check slots (the Account-slot mechanism of `@system/work`): a verify attempt waits for a slot, and one lost with its Host keeps it until no process has its throwaway `HOME`.
  `pass` when every check exits 0 and leaves nothing; `fail` when any does not or times out
  (unless the base fails it too, below); `error` when the commit cannot be checked out.
- **The base fails it too** (df-25): when a check fails on the change, the checks
  are run again by name on the base commit the checks were pinned from (not the
  parent of a further attempt, which is the failed change; a second worktree, the same
  `HOME`), in file order up to the last check that failed, so `install` and
  `build` run there too. When **every** check that failed on the change also
  fails on the base, the verdict is `inconclusive`, the reason says `<check>: the
  base fails it too (base <commit>)`, and the evidence holds the `check-run@1` of
  both runs (the change's first). A check that passes on the base keeps `fail`.
  A subject that is the base itself is not run twice. An `inconclusive` verdict
  does not reopen `implement` (retry `onFail` fires on `fail` only): the Work is
  held for an operator Approval before `publish`; approve lets it publish and merge,
  deny fails it.
- **Node** ([src/reasons.ts](src/reasons.ts), PROP-0007 decision 3): when the
  commit's `package.json` has `engines.node`, a Node that satisfies it goes
  first on the checks' `PATH`: the Host's own, else the newest under
  `~/.nvm/versions/node`, as `bin/system` looks; none is an `error` verdict.
  Whatever Node the Host's `PATH` starts with no longer decides.
- **Reasons** (decision 4): a check that failed under Node's test runner is
  one line, `<check>: <file> "<test>": <first error line>`, read from the
  runner's `failing tests` summary. A check runs under `timeout -s INT`, so on
  its time limit the runner prints what it was running:
  `<check>: timed out after <n> s while running <file> "<test>"`. Other
  commands keep `<check> (exit <n>)`. Several failures are joined by `; `.
- **Paths** (decision 5): a check with `paths` (globs, as GitHub Actions'
  `paths` filter, matched by `path.matchesGlob`) runs only when
  `git diff --name-only <base> <subject>` names a file one of them matches;
  the base is the commit the checks were pinned from, and also the subject's
  `parent` when it names one, so a reopened step's second attempt is selected
  by everything it changed since the base, not by its delta over the previous
  attempt. A check that failed in an earlier verdict of the same verify step
  in the Work (`VerifyRequest.earlier`, the evidence IDs of its non-pass
  verdicts) runs again whatever the diff selects, marked `(failed earlier)`
  in the reason. A commit checked as it
  is (`code-checks.yaml` on its own) runs every check. A skipped check has no
  `check-run@1`. The verdict's reason lists what ran, with its time, and what
  was skipped: `run: docs 0.4 s, unit 38.0 s; skipped: smoke`.
- **Criteria names** (df-26): the name a verify step gives is pinned in
  `checks@1` and chooses what the verdict means: `repo-checks-v1` (the rule
  above, `code-checks.yaml`) or one of the two below. Any other name refuses
  the Work at admission, naming the known ones.
  - **`red-v1`**, the red check of `feature.yaml`, on the tests step's change
    before any code: the selected checks run as above. A `red: fail` check
    that failed counts as red only when it passes on the base (run again
    there as df-25 does, up to the last such check). `pass` when every check
    with `red: pass` passed (such as build, docs) and at least one check is
    red; `fail` when a `red: pass` check failed (`failed: must pass with only
    the new tests: ...`; not run on the base), when no `red: fail` check
    failed (the tests prove nothing), when the change is the base itself, or
    when a check left a process running; `inconclusive` when every `red: fail`
    check that failed fails on the base too; `error` when the base cannot be
    checked out.
  - **`tests-frozen-v1`**, on the implement step's change with the tests
    step's change as the verify step's input `tests`: `fail` when the change,
    compared with the tests step's commit, adds, modifies or deletes a file
    the tests step's own change (against its parent) touched, naming the
    files; new files, new tests included, are allowed. No check runs (so
    nothing is run again on the base); one
    `check-run@1` records the `git diff` and the files. Without the input, or
    when the tests change names no parent, the verdict is `error`.

## `research.citation-check` (version 4)

- **Accepts:** `file` (the Worker's `sources` output).
- **Criteria:** `citation-criteria@1`: at least 1 source, quotes of at least
  8 characters, 20 s fetch timeout, 2 MiB per page, and `minConfirmedRatio`
  (0 to 1, default 0.5). Criteria pinned before version 2 lack the field and
  mean 1.0, so they keep their old meaning.
- **Format:** `{"sources": [{"id", "url", "quote", "claims": [..]}]}`; the
  Research Workflow's step instructions tell the Worker this shape.
- **Verify:** fetch each URL and search its text for the quote, ignoring
  markup, scripts, entities, Markdown code/emphasis marks (`` ` ``, `*`, `_`),
  Markdown link syntax (`[text](url)` reads as `text`), `|` (a table cell
  separator), case, whitespace and a space before `,.;:!?)`, on both the page
  and the quote. Inline tags (`a`, `span`, `em`...) are no word boundary
  (`(<span>[<a>TCP</a>]</span>)` reads as `([TCP])`); other tags are. One `citation-check@1` evidence Artifact
  records each URL's status and page hash, plus the confirmed ratio and the
  threshold used.
  - `fail`: a malformed file, too few sources or too-short quotes.
  - `pass`: at least `minConfirmedRatio` of the sources are confirmed.
  - `inconclusive`: fewer are.
  - **A pass can include unconfirmed quotes.** The verdict reason names each
    one and why ("HTTP 200, quote not found", "fetch failed: ..."), and the
    evidence lists every result, so nothing is hidden.
- **`citations-v2`** (the criteria name picks it; `citations-v1` above is
  unchanged, so earlier verdicts reproduce; the Research Workflows use v2).
  The operator's rule (2026-11-08): the check may be loose; the information must
  be complete and traceable.
  - **Criteria:** v1's plus `minWordMatch` (default 0.8); `minConfirmedRatio` 0.5.
  - **Loose match** (`looseMatch`): page and quote are normalised as above, then
    split into words (letters and digits, so punctuation never matters). A quote
    is confirmed when at least `minWordMatch` of its words appear in the same
    order within one window of the page's words, a window being the quote's
    length x 1.5. The search is bounded: a window starts only at a page word
    equal to one of the quote's first `n - ceil(n x minWordMatch) + 1` words
    (a match that good cannot skip more leading words), and the page is
    capped at 2 MiB. The evidence has, per source, `wordRatio`, `readable` and
    the nearest `passage` of the page (at most 300 characters); the reason names
    each unconfirmed source with its ratio.
  - **Completeness** (`completeness`), when the step gives the `report` as its
    `verify.inputs` (the Research Workflows do; the controller passes it as
    `VerifyRequest.inputs`): every `[id]` in the report (a Markdown link's text
    is not one) is in `sources`, every source is cited at least once, and
    every source has a claim. Otherwise `fail`, naming the ids.
  - **Fetch:** User-Agent `System-citation-check/1.0 (+https://github.com/tsuuanmi/System)`.
    HTTP 4xx/5xx or a fetch error makes a source unreadable: neither
    confirmed nor wrong. The ratio is over the readable sources; with none
    readable the verdict is `inconclusive`.
  - **Verdicts:** `fail` for a malformed file or an incomplete report;
    `pass` when the confirmed ratio of the readable sources is at least
    `minConfirmedRatio`; else `inconclusive`.
- **Limit:** this checks the web **as it is at verification time**. It never
  proves what the Worker read; that needs the System `fetch` tool (MVP-1).
  Claims are not checked against quotes.

Sources: [src/checks.ts](src/checks.ts), [src/citations.ts](src/citations.ts),
[src/index.ts](src/index.ts); tests: [tests](tests/README.md).
