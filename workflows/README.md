# Workflows

Workflow definitions are **data** (ADR-0002): `system.workflow/v1` YAML files
read at admission and pinned as a `workflow-spec@1` Artifact. Editing a file
changes future admissions only.

The canonical Workflows are `develop.yaml`, `hygiene.yaml`, `research.yaml`, `research-source.yaml`, `plan-items.yaml` and
`brainstorm.yaml`, and the Sub-workflow `code-checks.yaml`.

**Context pack.** A develop Task's instructions are prose under six headings, so
the Worker reads the named files first instead of exploring (no Task field; a Task
without them works as before): `Goal`; `Files to change and why`; `Tests to add or
update`; `Invariants not to change`; `Out of scope`; `Done when`. `develop.yaml`'s
`implement` reads the files named first, widens only when they are not enough, and
says in its result when the pack is wrong. An Item fits one Worker attempt (about an hour): a Done when with several independent parts is split into several Items by the caller (web-3, work:a216a2f9, ran out of its 60 minutes doing three parts). The MCP `instructions`
([packages/app/src/mcp.ts](../packages/app/src/mcp.ts)) tell callers to write it.

A step's `capabilities` are of three kinds (terms in [GLOSSARY.md](../GLOSSARY.md)):
an **Ability** is what a Runtime can do (`repo.read`, `repo.write`, `web.search`,
`web.browse`); a **Role** is a step's part in a Workflow, given to Accounts
(`develop.implement`, `brainstorm.*`, `review.second-opinion`); a **Tier** is a model class
(`tier.economy`, `tier.standard`, `tier.frontier`). `repo.write` is also what makes
the working tree a step's output. The old names (`code-write`, `web-search`,
`research.web`, `code.develop`) are unknown capabilities: a step needing one is refused at admission.

- [develop.yaml](develop.yaml) — the default for any change to a repository:
  `implement` (`repo.write`, `develop.implement`, `tier.standard`; works test-first:
  the tests for the new behaviour fail for the right reason, then the code, the
  existing tests that pin changed behaviour updated, the repository's checks run
  before it finishes) → `checks` (uses `code-checks.yaml`: step `checks.checks`)
  → `publish` (`git.publish`: the checked commit to `system/<work>`, one draft
  pull request) → `accept`. `implement`'s `retry` names `checks.checks` and
  `publish` (sc-7: a conflict or a failing check on the merge reopens it on the
  base's new tip); it sets `rerunUnchanged` (sc-9: a flaky check is re-run on the same change, not failed as "no change"; version 9). Version 10: `implement` also runs the docs checks (`tools/docs.py check`, `sync --check`, `impact <base> --waivers .system/docs-waivers`) against its base when the repository has `tools/docs.py`, so a stale doc is fixed inside the attempt; the instructions changed, the criteria did not, so no criteria version is pinned. Satisfied (ro-15; version 4): `implement` may also write the optional
  output `satisfied`, naming existing tests (`<test file> "<test name>"` per line)
  that show the Item already holds at the base; then `satisfied-check` runs exactly
  those tests on the Task's base, `checks`, `publish` and `accept` are skipped, and a
  pass ends the Work succeeded with the result "satisfied", publishing nothing.
- [hygiene.yaml](hygiene.yaml) — `scout-docs`, `scout-code` and `scout-tree`
  (`repo.write`, `tier.economy`, in parallel, read-only) → `plan` (picks what
  is worth doing) → `implement` (`retry` on `checks.checks` and `publish`, sc-7, and `rerunUnchanged`, sc-9; version 6: the same docs checks as develop.yaml version 10, instructions only, no criteria change) → `checks` → `publish` → `accept`: one pull
  request of cleanup for any repository that has `.system/checks.yaml`. It fits a change that keeps behaviour.
- [code-checks.yaml](code-checks.yaml) — `checks` (`code.required-checks`
  on the input change, criteria pinned from its base). A Sub-workflow of
  `develop.yaml` and `hygiene.yaml`; on its own, on a task with a base, it checks that commit as it is.
  `system work retry <work> --step checks.checks` verifies the same change again.
  A new criteria version is pinned in a Workflow only in a release after the one that added it, because `system update` checks a release with the running Host's verifiers.
  A check that fails on the change and on its base, and again on both after one re-run (sc-13), is `inconclusive` (df-25): the Work is held for approval, not retried (before `publish`) ([runbook](../docs/operations/runbook.md#a-check-the-base-fails-too)).
- [research.yaml](research.yaml) — `investigate` (`web.search`, `tier.standard`, `prefer: web.browse`, one `retry`;
  outputs `report`, `sources`) → `citations` (`research.citation-check` on
  `sources`, with the `report` as an input; criteria `citations-v3`) → `accept`. `investigate` goes to an Account whose
  Runtime has `web.browse` (a `web` Account) and to any other capable Account
  when none can take it (unavailable, signed out, limited, no free slot, or its attempt failed and it
  left routing); `prefer` ranks without requiring, so a Host with no such Account still runs it; version 7.
- [research-source.yaml](research-source.yaml) — same steps, verifier and criteria as `research.yaml`, but `investigate` needs `web.search` and `repo.read` (so a web Account cannot take it) and has no `prefer`, and reads the Task's repository checkout, citing public repositories by pinned `raw.githubusercontent.com/<owner>/<repo>/<commit>/<path>` URLs. Use `research.yaml` for questions answered from the web, `research-source.yaml` for questions about a repository's source.
- [brainstorm.yaml](brainstorm.yaml) — `idea-a` (`brainstorm.idea-a`) and
  `idea-b` (`brainstorm.idea-b`) each write a `proposal` from the brief alone,
  with a stance each (pragmatist, skeptic);
  `synthesis` (`brainstorm.synthesis`) reads both exact proposals and writes a
  `summary`. No verifier: success means the three outputs exist. The bundle
  gives `idea-a` and `synthesis` to Claude Code and `idea-b` to Codex.

- [plan-items.yaml](plan-items.yaml) — `propose` (`repo.read`, never `repo.write`, `tier.standard`) reads the Intent in the Task's context and the repository's `STATUS.md` and `PLAN.md`, and writes the output `items`: proposed Item lines in STATUS.md's grammar (`- [ ] <id> <text> (intent: <12 hex>) (after: ...)`, `after:` only for real dependencies, new ids, a Done-when clause in each). It has no verify or accept step (an accept step needs a verify step, and a verifier that runs `status-parse.ts` would be a new Host capability). It writes nothing to STATUS: the caller shows `items` to the operator and only after the operator agrees submits a docs Work (`develop.yaml`) that adds the lines. The scheduled session never runs it ([night-session.md](../tools/night-session.md)).

Comparison configurations for the Brainstorm evaluation, and the Workflows that
are not canonical (`second-opinion.yaml`),
are in [experiments](experiments/README.md).

```sh
bin/system work submit --workflow workflows/research.yaml --input <artifactId>
```

[`tools/web-canary`](../tools/web-canary) runs it on a fixed question for the
`web` Accounts ([runbook](../docs/operations/runbook.md#the-web-canary)).

Compatibility policy: criteria versions and Artifact kinds are not deleted (old records must replay), except `citations-v1`, removed on 2026-11-16 by the operator (a Work pinned to it cannot be retried; `work replay` reads events only).
A change across a release boundary is expand then contract, with a registered removal Item (the Q0 rule
above: a new criteria version is pinned only in a later release). Nothing else keeps fallbacks or aliases.

**Guardrail rule** (operator, 2026-11-15, Q8): each Escaped defect or recurring failure ends in an enforced test, type,
lint, API or check that is proven to block it; prose is allowed only when that is impossible, with the reason.

The vocabulary and preflight rules are in
[workflow composition](../docs/architecture/workflow-composition.md).
