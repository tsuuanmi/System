import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

test('two hosts racing for a stale lock never both win', async () => {
  const { spawn } = await import('node:child_process')
  const { pathToFileURL, fileURLToPath } = await import('node:url')
  const source = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'control.ts')).href
  const contender = `
    const { FileControl } = await import(${JSON.stringify(source)})
    const control = new FileControl(process.argv[1])
    try {
      const release = control.acquire('work:race')
      await new Promise((r) => setTimeout(r, 300))
      release()
      console.log('won')
    } catch {
      console.log('lost')
    }`
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout
  let doubleWins = 0
  for (let round = 0; round < 15; round++) {
    const raceDir = join(dir, `race-${round}`)
    new FileControl(raceDir)
    writeFileSync(join(raceDir, 'work_race.lock'), dead)
    const outcomes = await Promise.all([0, 1].map(() => new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', contender, raceDir], { stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.on('close', () => resolve(out.trim()))
    })))
    if (outcomes.filter((o) => o === 'won').length > 1) doubleWins += 1
  }
  assert.equal(doubleWins, 0)
})
