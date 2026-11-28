import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as contract from '../src/contract.ts'
import * as entry from '../src/index.ts'
import pkg from '../package.json' with { type: 'json' }

// ADR-0017 decision 1: what other packages import from `@system/runtime-cli` is behind `./contract`.
test('the contract exports the values other packages use, the same ones the entry has', () => {
  for (const name of ['maskValues', 'subprocessSpawner', 'runAttempt', 'exited', 'lazyVersion', 'mediaTypeOf', 'RUNTIME_ABILITIES', 'nodeBin', 'satisfies', 'recordingPid'] as const) {
    assert.ok(name in contract, `${name} is exported by the contract`)
    assert.equal(contract[name], entry[name], `${name} is the entry's`)
  }
})

test('package.json exports ./contract', () => {
  assert.deepEqual((pkg.exports as Record<string, string>)['./contract'], './lib/contract.js')
})

test('the contract does not import the plugin entry', async () => {
  const { readFileSync } = await import('node:fs')
  assert.doesNotMatch(readFileSync(new URL('../src/contract.ts', import.meta.url), 'utf8'), /from '\.\/index\.ts'/)
})
