// Preloaded by every test script (`node --import ./test-support/clean-git-env.mjs`, package.json): drops the variables that point git at a
// repository from the test process, so no child it spawns inherits them. A test run from a git hook (the pre-push hook runs `pnpm test`)
// would otherwise run `git init --bare` or `git config` on the operator's real repository (Escaped defect 01d80c6a).
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_QUARANTINE_PATH', 'GIT_PUSH_OPTION_COUNT']) delete process.env[key]
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_PUSH_OPTION_')) delete process.env[key]
