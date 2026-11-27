/** The layer tests' skip decision (test-support/layer-gate.ts): run, skip, or fail under SYSTEM_REQUIRE_SANDBOX=1. */
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { layerDecision, layerSkip } from '../test-support/layer-gate.ts'

const dir = mkdtempSync(join(tmpdir(), 'system-layer-gate-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const script = (name: string, body: string) => {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}
const broken = script('bwrap', 'exit 1')
const working = script('bwrap-ok', 'exit 0')
const reason = 'unprivileged user namespaces are off here (bubblewrap cannot start)'

test('with the variable and a bwrap that cannot start the decision is fail, with the reason', () => {
  const env = { SYSTEM_REQUIRE_SANDBOX: '1' }
  assert.deepEqual(layerDecision(broken, reason, env), { decision: 'fail', reason })
  assert.deepEqual(layerDecision(undefined, reason, env), { decision: 'fail', reason })
  assert.throws(() => layerSkip(broken, reason, env), (e: Error) => e.message.includes(reason))
})

test('without the variable the decision is skip with the reason', () => {
  assert.deepEqual(layerDecision(broken, reason, {}), { decision: 'skip', reason })
  assert.equal(layerSkip(broken, reason, {}), reason)
  assert.equal(layerSkip(undefined, reason, { SYSTEM_REQUIRE_SANDBOX: '0' }), reason)
})

test('with a bwrap that starts the decision is run, with or without the variable', () => {
  for (const env of [{}, { SYSTEM_REQUIRE_SANDBOX: '1' }]) {
    assert.deepEqual(layerDecision(working, reason, env), { decision: 'run' })
    assert.equal(layerSkip(working, reason, env), false)
  }
})
