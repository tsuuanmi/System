# test-support

Helpers shared by the tests, so each stand-in has one implementation: the
in-memory stores, the fake Workers and CLIs, the throwaway `DSH_HOME` runner for
the [smoke tests](../tests/README.md), the headed-Chrome and publish helpers.
The header of each file says what it provides; this README does not list them.

Rules:

- It is not a package: tests import it by path. It imports the built
  `@system/*` packages, so run `corepack pnpm build` first (`corepack pnpm check`
  does).
- A stand-in lives here once. A test that needs one that exists imports it
  instead of writing its own; a second copy in a test file is moved here.
- Nothing here is product code: no `src` file imports it.
- [clean-git-env.mjs](clean-git-env.mjs) is preloaded by the test scripts in
  [package.json](../package.json) (`--import`): it removes `GIT_DIR` and the other
  repository-pointing variables a git hook sets, so a test never changes the real
  repository. A new test script preloads it too.
- A missing Chrome or Xvfb, or a Chrome that does not start, **fails** the file
  that imports [headed.ts](headed.ts) instead of skipping its tests: the checks
  once passed on a host where those tests fail. `SYSTEM_SKIP_HEADED=1` skips them.
- A fake never reads a real secret; a fake account home holds secrets beside the
  file under test so a test can show they are never read.
