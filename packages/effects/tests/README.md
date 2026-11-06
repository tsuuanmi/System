# @system/effects tests

`git.publish` against real bare git repositories and an in-process fake
GitHub API that records every call. The booted profile, with crashes on both
sides of the remote effect, is covered by
[tests/publish.test.ts](../../../tests/README.md).
