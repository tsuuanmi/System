---
type: operations
status: active
reviewed: 2026-11-27
summary: Updating the installed release, rolling it back, and the dev branch.
covers: [bin/update.mjs]
---

# Releases

Part of the [runbook](runbook.md).

## Upgrading

`system update [--wait <minutes>] [--to <release>]` moves the install to the newest commit of
`main`, and only to code that passed its own checks on this machine:

- it fetches `main` (the commit already current is nothing to do), adds
  `releases/<commit>` and runs `corepack pnpm install --frozen-lockfile` and
  `corepack pnpm build` there;
- it checks that commit by a Work, `workflows/code-checks.yaml` on a task whose
  base is the commit, and prints the Work ID: the evidence, bound to the exact
  commit. Both the release check and the `afterInstall` check below are judged
  by the Work's recorded terminal state (`succeeded` passes; `failed`,
  `cancelled`, `held`, a missing Work ID or an unreadable Work fails closed; a
  still-running Work is followed within `--wait`), not by the `work submit`
  client's exit status. A failed build or check leaves `current` where it was. With a
  `current`, the commit is checked as a change from the release that runs now,
  so `paths` selects the checks by the files that differ between the two
  releases; the first install checks the whole commit. When the release that runs now knows the
  criteria `repo-checks-release-v1`, the check is of the event `release` (a check's `on:`), by a
  workflow `update` writes; otherwise `code-checks.yaml` (event `pull_request`).
  This repository's release check runs `upgrade` and `install-guide`, which a Work's
  checks do not run ([ADR-0014](../decisions/ADR-0014-checks-in-tiers-by-event.md)); a
  failure there leaves `current` where it was, and `system work report` counts it as a
  late-caught defect;
- it switches `current` (a new link renamed over it), then asks the Host as a
  client of the new code, which makes the Host drain and restart on it (below);
- if the Host does not run the new code within `--wait` (default 75 minutes,
  more than one attempt's time limit), it switches `current` back, and the
  unit's next start runs the code before;
- once the Host runs it, the commit's `.system/checks.yaml` may list
  `afterInstall` checks (the schema of `checks`): `system update` runs them as a
  Work of the verifier `release.install-check`, with the installed `system` on
  PATH, and prints the Work ID (a Verdict bound to the commit). When one fails
  it switches `current` back to the release before, asks the Host to run it, and
  names the failed check. Releases other than the current one and the one
  before are removed;
- the switch first writes `~/.system/pending-install-check.json` (the commit,
  the release before, the task, the workflow), removed once the check passes or
  `current` is switched back. When `system update` is killed after the switch
  (the Host may wait a long time for a running attempt), the Host that starts on
  that release finds the record and runs `system update --finish-pending`
  itself: the same check and the same switch back, with no session. A live
  `system update` completes its own check.

While it upgrades the Host starts no new attempt and lets the running ones
finish; Works can still be submitted and wait. The log lines, exit status,
retries and exit grace are in [the Host](../architecture/host.md#upgrading-on-new-code-d).
A command run meanwhile waits up to 3 s, reads still work, and one that changes
something says to retry once the Host has restarted.
`systemctl --user restart system` stops the Host at once and interrupts the
attempts. A Host run from a development checkout restarts itself on a build
there, not while the `.building` file `corepack pnpm build` keeps exists.

A release is a pull request from `dev` to `main`, merged by the operator, then `system update`.
The docs CI's `impact` check fails when the release changes a path a doc `covers:` without changing
that doc ([the tool](../../tools/docs.py), [governance](../governance/documentation.md)). When the doc
is still true, a line `docs-unchanged: <path> — <reason>` in the pull request body waives it. System's
`docs` check runs the same impact check on every Work, so most are found earlier; its waivers are the
lines of `.system/docs-waivers`, committed with the change. Clear that file's waiver lines in the release
pull request (keep its comment line); the docs CI fails a pull request into `main` that leaves one.
Editing the body does not rerun CI: close and reopen the pull request.

The release report, the pull request body, ends with a "How to revert" part: the command
`system update --to <commit>` with the commit of the release before (the `main` commit the install runs now), and
what a revert does not undo (a record schema change, above).

## Rollback

`system update --to <release>` (a commit in `~/.system/releases`, or a unique prefix of one; normally the
release before, which `ls ~/.system/releases` shows next to `current`) switches `current` to that kept release
through the same switch, drain and `afterInstall` check as an update (the pending record, the Host asked until
it runs it, a failed check or a Host that does not come up switches back to the release it left). It fetches,
builds and checks nothing: a kept release passed that when it was installed. A release not in `releases/` is
refused and nothing changes; the release already current is nothing to do. `tools/upgrade-rehearsal.mjs`
rehearses a revert to the previous release.

```
system update --to <commit>
```

Like an update it makes the Host drain: running attempts finish first (`--wait`). `systemctl --user restart
system` stops the Host at once and interrupts them. What the Host then runs again by itself, and what waits
for `system work run`, is in [Stop, restart, status](install-and-update.md#stop-restart-status). A release
refuses a store whose records it does not know only if a later release changed the record schema (`git diff
<commit>..<later> -- packages/work/src/record.ts packages/artifacts/src` shows it).

## The dev branch

System merges a Work's change into `dev` only through its merge queue
([effects README](../../packages/effects/README.md), [ADR-0008](../decisions/ADR-0008-dev-integration-branch.md)).
A conflict fails the publish step naming the files; a check that fails on the
merge names it in the reason. Do not require pull requests in `dev`'s branch
protection: the push would be refused.

The queue merges one change at a time; a profile that still sets `mergeBatchSize`
stops the Host at start (the option was removed, ct-4).

A hand push to `dev` can run the fast checks first: in your checkout run
`git config core.hooksPath tools/hooks` (`tools/hooks/pre-push`; bypass once with `git push --no-verify`).
System's own publish pushes from attempt worktrees with `core.hooksPath=/dev/null`, so the hook never runs for it.
The hook acts only on a push to the remote named `origin` whose URL is not a local path or a `file:` URL,
and it clears every inherited `GIT_*` repository variable before a check runs,
so it cannot change the operator's repository.
The sandbox Account option (iso-1) is the second guard: inside its layer, a linked worktree cannot write
the main repository's `config` or `hooks/`; `packages/agents/tests/sandbox.test.ts` shows it.
