# tools

Scripts that the checks ([`.system/checks.yaml`](../.system/checks.yaml)), the git
hooks, the install or a systemd unit run by path. This README does not list them:
the header of each file says what it does.

- **A path here is an interface.** [bootstrap-plan.ts](../packages/app/src/bootstrap-plan.ts),
  `.system/checks.yaml`, [.github/workflows/docs.yml](../.github/workflows/docs.yml)
  and `packages/bundle` name files in this directory, and an installed release or a
  unit file may too. Moving or renaming one changes those; a new script is added
  with the caller that runs it.
- **The pre-push hook** is `tools/hooks/pre-push`. Enable it once per clone with
  `git config core.hooksPath tools/hooks`; skip it once with `git push --no-verify`.
- **`tools/*.ts` run by Node's type stripping** (`node tools/<file>.ts`): no build
  step, so they use erasable TypeScript syntax only (no enums, no parameter
  properties) and import with explicit extensions.
