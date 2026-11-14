# @system/effects

The `effects` row: System's external effect providers
([ADR-0004](../../docs/decisions/ADR-0004-mvp-0-operating-decisions.md)
decisions 10-11, MVP-03). **Injects:** `capabilities`, `artifacts`,
`credentials` (DSH). Workers never hold these credentials.

## The contract (`EffectPort` in `@system/work`)

A provider has a `ref`, a `version`, the subject kinds it `accepts`, and
`validate(params)` (at admission), `approval(intent)` (a reason when an
operator must approve), `apply(intent)` and `reconcile(intent)`, which only
reads. An intent's `operationId` is stable for one Work, step and subject.
The controller records `effect-intended` before `apply` and
`effect-observed` after it; after a lost host or a failed `apply` it calls
`reconcile` and applies again only when the remote shows the effect `absent`.
`unknown` holds the Work for the operator.

## `git.publish` for GitHub (version 1)

```yaml
- id: effects
  config:
    remote: origin                   # the remote of the subject's repository
    base: dev                        # what pull requests target (ADR-0008)
    mergeInto: [dev]                 # the bases System may merge into; default none
    apiUrl: https://api.github.com
    repository: owner/name           # optional; parsed from a github.com remote
    tokenRef: GITHUB_TOKEN           # system credentials set GITHUB_TOKEN
```

- **Apply:** push the exact `git-tree` commit to `system/<work>` with a
  lease on the commit just read, then reuse the branch's open pull request or
  open one as a **draft**. A branch already at the commit is not pushed again.
- **The branch moves only from a commit System published** (pinned under
  `refs/system/artifacts/` when an attempt was captured); any other commit
  there is refused, never overwritten.
- **Reconcile:** `applied` when the branch holds the commit and its pull
  request is open (and ready, if asked) or, with `merge: true`, when the base
  holds the change; `absent` otherwise; `unknown` when the remote or the API
  cannot be read. It only reads the remote.
- **Parameters:** `ready: true|false` and `merge: true|false`. `ready: true`
  marks the pull request ready for review and needs an operator's approval.
  `merge: true` needs none (ADR-0008 authorises it), but `validate` refuses it
  unless `base` is in `mergeInto`, and refuses it together with `ready`.
- **Token:** git receives it through `GIT_CONFIG_*` environment variables (an
  `http.extraHeader`), never in its arguments; the API through the
  Authorization header.
- **Merge (`merge: true`), the merge queue** ([ADR-0008 amendment](../../docs/decisions/ADR-0008-dev-integration-branch.md)):
  one change at a time per base. A change that holds the base's tip goes in
  as it is. Any other is merged with the tip by `git merge-tree` (a conflict
  is `failed`, naming the files); the merge commit is pinned, stored as a
  `git-tree@1` and checked with the effect's `required` checks and their
  pinned criteria. The re-check is a verification like any other
  (`mergeCheck`): it runs the verifier ref and version pinned at admission,
  binds subject, criteria and evidence with the controller's `bindVerdict`
  (a pass without stored evidence is refused) and stores a verdict Artifact
  per check, named in `detail.verdicts`. A verdict other than `pass` or
  `inconclusive` is `failed`. An `inconclusive` verdict, or a verifier version
  that changed since admission, holds the Work (`held`: the merge commit, no
  push) for an Approval of that commit; the approved commit is pushed as it
  is (`approvedMerge`) while the base is still its parent, and an Approval
  given for another commit counts for nothing. The commit goes to `system/<work>`, the pull request is opened ready, and the base moves to
  exactly that commit by a push with a lease on the checked tip; if the base
  moved, the change is merged and checked again (three rounds at most). A
  conflict and a failing check on the merge return `rejected: 'conflict' |
  'merge-check'` and `detail.base`, the `git-tree@1` Artifact of the tip (sc-7):
  a Worker step that lists the publish step in `retry.onFail` is reopened on that
  tip with its previous change and the reason as input
  ([workflow composition](../../docs/architecture/workflow-composition.md)). No
  other failure sets `rejected`, and an unknown outcome is never retried. The
  outcome detail adds `merged: "true"`, `mergeCommit` and, after a merge,
  `checkedOn` (the tip it was checked with). GitHub's merge endpoint is not
  used. A branch protection requiring pull requests refuses the push, which
  is `failed` with git's message.
- **Required checks (ADR-0008, clarified 2026-11-07):** System merges once its
  own verifier (`code.required-checks` over `.system/checks.yaml`) has passed
  on the exact commit it moves the base to. It does not wait for GitHub's CI.
- **Base:** a pull request is the branch's only when its `base` is the
  configured one. An open pull request for the branch that targets another
  base makes `apply` `failed`, naming both bases; it is never merged or
  retargeted. A pull request merged into another base does not count as
  merged. Only the operator merges `dev` into `main`.

## Verified

Against a real bare git remote (`file://`) and a fake GitHub API, in unit
tests and on the booted profile (`tests/publish*.test.ts`), including a host
killed after the pull request was created, one killed during the push and one
killed once the base moved (a `post-receive` hook of the remote). The merge
queue's rounds (a change merged with a tip that has another, a conflict, a
failed check on the merge, a tip moving while it is checked) are unit tests.
The tests do not touch github.com; System itself publishes its Works as pull
requests and merges them into `dev` on GitHub, which is the live use.

Sources: [src/github.ts](src/github.ts), [src/index.ts](src/index.ts);
tests: [tests](tests/README.md).
