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
