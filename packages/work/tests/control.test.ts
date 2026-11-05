import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { FileControl } from '../src/control.ts'

const dir = mkdtempSync(join(tmpdir(), 'system-control-'))
after(() => rmSync(dir, { recursive: true, force: true }))

test('one live holder per Work; release frees it', () => {
  const control = new FileControl(dir)
  const release = control.acquire('work:a')
  assert.equal(control.heldElsewhere('work:a'), true)
  assert.throws(() => control.acquire('work:a'))
  release()
  assert.equal(control.heldElsewhere('work:a'), false)
  control.acquire('work:a')()
})

test('a lock left by a dead process is stale and taken over', () => {
  const control = new FileControl(dir)
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout
  writeFileSync(join(dir, 'work_b.lock'), dead)
  assert.equal(control.heldElsewhere('work:b'), false)
  control.acquire('work:b')()
})

test('a cancel request is read until cleared', () => {
  const control = new FileControl(dir)
  assert.equal(control.cancelRequest('work:c'), undefined)
  control.requestCancel('work:c', { reason: 'r', caller: { type: 'human', operatorId: 't' } })
  assert.deepEqual(control.cancelRequest('work:c'), { reason: 'r', caller: { type: 'human', operatorId: 't' } })
  control.clearCancel('work:c')
  assert.equal(control.cancelRequest('work:c'), undefined)
})
