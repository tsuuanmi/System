/**
 * This repository's own `.system/checks.yaml`: valid, and fast by construction.
 * The verifier runs the checks in one worktree with one HOME, so the install
 * and the build belong in one check each, and no later check repeats them.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parse } from 'yaml'
import { checksFileSchema } from '../src/checks.ts'

const { checks } = checksFileSchema.parse(parse(readFileSync(new URL('../../../.system/checks.yaml', import.meta.url), 'utf8')))
const running = (word: string) => checks.filter((check) => new RegExp(`pnpm (${word})\\b`).test(check.run)).map((check) => check.name)

test('the install and the build each run once, in a check of their own name', () => {
  assert.deepEqual(running('install'), ['install'])
  assert.deepEqual(running('build'), ['build'])
})

test('the parts run in order: install, build, then the checks that need them', () => {
  const order = checks.map((check) => check.name)
  assert.ok(order.indexOf('install') < order.indexOf('build'))
  for (const name of ['typecheck', 'unit', 'smoke']) assert.ok(order.indexOf('build') < order.indexOf(name), name)
})

test('lint runs after install, on TypeScript files and the config', () => {
  const lint = checks.find((check) => check.name === 'lint')
  assert.ok(lint)
  assert.match(lint.run, /pnpm lint\b/)
  assert.ok(checks.map((check) => check.name).indexOf('install') < checks.indexOf(lint))
  assert.ok(lint.paths?.includes('eslint.config.js'))
})

// ct-2, ADR-0014 decision 2: which checks each event runs.
const runsOn = (event: 'pull_request' | 'merge_group' | 'release') => checks.filter((check) => !check.on || check.on.includes(event)).map((check) => check.name)

test('pull_request runs neither upgrade nor install-guide', () => {
  const names = runsOn('pull_request')
  assert.ok(!names.includes('upgrade') && !names.includes('install-guide'))
  for (const name of ['secrets', 'lint', 'smoke', 'web', 'unit']) assert.ok(names.includes(name), name)
})

test('merge_group runs neither smoke, lint, secrets nor web', () => {
  const names = runsOn('merge_group')
  for (const name of ['smoke', 'lint', 'secrets', 'web', 'upgrade', 'install-guide']) assert.ok(!names.includes(name), name)
  for (const name of ['docs', 'statusmd', 'install', 'build', 'typecheck', 'unit']) assert.ok(names.includes(name), name)
})

test('release runs every check', () => {
  assert.deepEqual(runsOn('release'), checks.map((check) => check.name))
})
