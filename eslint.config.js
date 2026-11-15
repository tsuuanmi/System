// Item fl-10: two rules only. `@typescript-eslint/no-floating-promises` catches a promise
// dropped inside try/finally; `@typescript-eslint/return-await` ('in-try-catch') catches
// Escaped defect 4's exact shape, `return promise.then(...)` inside try with a finally
// (cleanup ran before git finished).
// Type-aware through the repository's tsconfig.json.
import tseslint from 'typescript-eslint'

export default [
  // The fixture is a deliberate violation: lint.test.ts lints it with --no-ignore.
  { ignores: ['**/lib/', '**/dist/', '**/node_modules/', 'packages/verifiers/tests/fixtures/'] },
  {
    files: ['packages/*/src/**/*.ts', 'packages/*/tests/**/*.ts', 'tests/**/*.ts', 'test-support/**/*.ts'],
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
]
