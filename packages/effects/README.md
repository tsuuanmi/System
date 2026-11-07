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
  request is open (and ready, if asked) or, with `merge: true`, merged at the
  commit; `absent` otherwise (an open, unmerged pull request included, so the
  controller may apply again); `unknown` when the remote or the API cannot be
  read. It only reads.
- **Parameters:** `ready: true|false` and `merge: true|false`. `ready: true`
  marks the pull request ready for review and needs an operator's approval.
  `merge: true` needs none (ADR-0008 authorises it), but `validate` refuses it
  unless `base` is in `mergeInto`, and refuses it together with `ready`.
- **Token:** git receives it through `GIT_CONFIG_*` environment variables (an
  `http.extraHeader`), never in its arguments; the API through the
  Authorization header.
- **Merge (`merge: true`):** the pull request is opened ready, not as a draft
  (a reused draft is marked ready), then merged with
  `PUT /pulls/{n}/merge` carrying `sha`, the exact verified commit, and
  `merge_method: merge`; GitHub refuses if the head moved. The outcome detail
  adds `merged: "true"` and `mergeCommit`. A 405 (not mergeable) or 409 (head
  changed) is `failed` with GitHub's message and is never retried; a pull
  request already merged at the commit is `applied` without a second call.
  Without `merge: true` there is no merge call.
- **Required checks (ADR-0008, clarified 2026-11-07):** System merges once its
  own verifier (`code.required-checks` over `.system/checks.yaml`) has passed
  on the exact commit. It does not wait for GitHub's CI; branch protection, if
  configured, can still refuse the merge with 405, recorded as `failed`.
- **Base:** a pull request is the branch's only when its `base` is the
  configured one. An open pull request for the branch that targets another
  base makes `apply` `failed`, naming both bases; it is never merged or
  retargeted. A pull request merged into another base does not count as
  merged. Only the operator merges `dev` into `main`.

## Verified

Against a real bare git remote (`file://`) and a fake GitHub API, in unit
tests and on the booted profile (`tests/publish.test.ts`), including a host
killed after the pull request was created, one killed during the push and one
killed after the merge call.
**Not yet run against github.com**: that needs a throwaway repository and a
token the operator authorises.

Sources: [src/github.ts](src/github.ts), [src/index.ts](src/index.ts);
tests: [tests](tests/README.md).
