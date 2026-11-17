/**
 * web-3a: the `web` check (`pnpm test:web`) is for tests that start a browser, Xvfb or a Host-driven site, so each file its
 * script lists must use the shared helper test-support/headed.ts (CHROME, skipHeaded) or the marker test-support/browser-test.ts, directly or through chatgpt-support.ts,
 * which imports it. A logic-only test belongs in the unit run (a `*.unit.test.ts` file beside it, matched by `pnpm test`):
 * it runs in seconds on every change instead of waiting for the web check.
 */
import assert from 'node:assert/strict'
import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const scripts = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts

/** The files `test:web` names, its globs expanded. */
const webFiles = (): string[] => scripts['test:web']!.split(/\s+/).filter((word) => /\.test\.ts$/.test(word)).flatMap((word) => globSync(word, { cwd: repo })).sort()

/** Whether the test file starts a browser through the shared helper: it imports it, or imports chatgpt-support.ts, which does. */
const usesHeadedHelper = (file: string): boolean => /test-support\/(headed|browser-test)\.ts'/.test(readFileSync(join(repo, file), 'utf8')) || (/from '\.\/chatgpt-support\.ts'/.test(readFileSync(join(repo, file), 'utf8')) && usesHeadedHelper('packages/web-worker/tests/chatgpt-support.ts'))

test('test:web lists files, and every one exists', () => {
  const files = webFiles()
  assert.ok(files.length >= 5, `test:web matches ${files.length} files`)
  for (const file of files) assert.ok(existsSync(join(repo, file)), file)
})

test('every file the web check runs uses the shared headed-browser helper; a logic-only test belongs in the unit run', () => {
  const logicOnly = webFiles().filter((file) => !usesHeadedHelper(file))
  assert.deepEqual(logicOnly, [], 'these files in test:web start no browser: move each to <name>.unit.test.ts, which `pnpm test` runs, or use test-support/headed.ts or browser-test.ts')
})
