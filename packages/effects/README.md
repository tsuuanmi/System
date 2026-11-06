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
  request is open (and ready, if asked); `absent` otherwise; `unknown` when
  the remote or the API cannot be read.
- **Parameters:** only `ready: true|false`. `ready: true` marks the pull
  request ready for review and needs an operator's approval.
- **Token:** git receives it through `GIT_CONFIG_*` environment variables (an
  `http.extraHeader`), never in its arguments; the API through the
  Authorization header.
- **It never merges.** There is no merge call.

## Verified

Against a real bare git remote (`file://`) and a fake GitHub API, in unit
tests and on the booted profile (`tests/publish.test.ts`), including a host
killed after the pull request was created and one killed during the push.
**Not yet run against github.com**: that needs a throwaway repository and a
token the operator authorises.

Sources: [src/github.ts](src/github.ts), [src/index.ts](src/index.ts);
tests: [tests](tests/README.md).
