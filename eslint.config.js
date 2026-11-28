// Item fl-10: two rules only. `@typescript-eslint/no-floating-promises` catches a promise
// dropped inside try/finally; `@typescript-eslint/return-await` ('in-try-catch') catches
// Escaped defect 4's exact shape, `return promise.then(...)` inside try with a finally
// (cleanup ran before git finished).
// Type-aware through the repository's tsconfig.json.
import tseslint from 'typescript-eslint'

// Item plug-5 (ADR-0017 decision 5): a module under packages/<a>/src imports values from another
// `@system/*` package only through its `./contract` subpath or a library package, never from a
// plugin package's root and never by a relative path into another package. `import type` is allowed.
const LIBRARIES = ['host', 'web-driver', 'git']
const boundary = {
  patterns: [
    {
      regex: `^@system/(?!(${LIBRARIES.join('|')})$)[^/]+$`,
      allowTypeImports: true,
      message: "Import values from another plugin package through its './contract' subpath (ADR-0017); `import type` is allowed.",
    },
    {
      regex: '^(\\.\\./){2,}[^/]+/(lib|src)(/|$)',
      allowTypeImports: true,
      message: "Do not import a value from another package by a relative path; use its package name (ADR-0017).",
    },
  ],
}

// TODAY'S VIOLATIONS (RES-0021), one file each. THIS LIST MAY ONLY SHRINK: never add a file to it;
// remove a file when its imports are fixed (plug-7 to plug-11, plug-15 do so).
const BASELINE = [
  'packages/agents/src/agent.ts',
  'packages/agents/src/index.ts',
  'packages/agents/src/quota.ts',
  'packages/agents/src/workspace.ts',
  'packages/app/src/bootstrap-plan.ts',
  'packages/app/src/bootstrap.ts',
  'packages/app/src/cli.ts',
  'packages/app/src/client.ts',
  'packages/app/src/index.ts',
  'packages/app/src/io.ts',
  'packages/app/src/mcp.ts',
  'packages/app/src/remote.ts',
  'packages/classifier/src/classifier.ts',
  'packages/classifier/src/eval.ts',
  'packages/classifier/src/index.ts',
  'packages/classifier/src/schema.ts',
  'packages/effects/src/github.ts',
  'packages/effects/src/index.ts',
  'packages/fakes/src/index.ts',
  'packages/host/src/index.ts',
  'packages/host/src/operations.ts',
  'packages/host/src/process.ts',
  'packages/verifiers/src/checks.ts',
  'packages/verifiers/src/install-check.ts',
  'packages/web-worker/src/chatgpt.ts',
  'packages/web-worker/src/index.ts',
  'packages/work/src/confirmation.ts',
  'packages/work/src/controller.ts',
  'packages/work/src/conversation.ts',
  'packages/work/src/defect.ts',
  'packages/work/src/host.ts',
  'packages/work/src/index.ts',
  'packages/work/src/intent.ts',
  'packages/work/src/kinds.ts',
  'packages/work/src/record.ts',
]

export default [
  // The fixture is a deliberate violation: lint.test.ts lints it with --no-ignore.
  { ignores: ['**/lib/', '**/dist/', '**/node_modules/', 'packages/verifiers/tests/fixtures/'] },
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/tests/**/*.ts', 'tests/**/*.ts', 'test-support/**/*.ts', 'tools/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          // node:test registers a test, a suite or a hook and tracks its promise itself.
          allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite', 'before', 'after', 'beforeEach', 'afterEach'] }],
        },
      ],
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
    },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: BASELINE,
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: { '@typescript-eslint/no-restricted-imports': ['error', boundary] },
  },
]
