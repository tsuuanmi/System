import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { WorkError } from '../src/errors.ts'
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

test('a lock another host is still publishing (no pid yet) is not stale: no second holder', () => {
  const control = new FileControl(dir)
  writeFileSync(join(dir, 'work_d.lock'), '')
  assert.throws(() => control.acquire('work:d'), /is being run by another process/)
  assert.equal(readFileSync(join(dir, 'work_d.lock'), 'utf8'), '', 'the publishing host keeps its lock')
})

test('an empty lock left long ago (a host that died while publishing) is stale and taken over', () => {
  const control = new FileControl(dir)
  const lock = join(dir, 'work_e.lock')
  writeFileSync(lock, '')
  const old = new Date(Date.now() - 60_000)
  utimesSync(lock, old, old)
  control.acquire('work:e')()
})

test('the last write of a Work survives the process, starts unset, and an unparsable mark reads as unset', () => {
  const control = new FileControl(dir)
  assert.equal(control.lastWrite('work:g'), undefined)
  control.noteWrite('work:g', { host: 'a', at: 7 })
  assert.deepEqual(new FileControl(dir).lastWrite('work:g'), { host: 'a', at: 7 })
  writeFileSync(join(dir, 'work_g.written'), 'not json')
  assert.equal(control.lastWrite('work:g'), undefined)
})

test('a cancel request is read until cleared', () => {
  const control = new FileControl(dir)
  assert.equal(control.cancelRequest('work:c'), undefined)
  control.requestCancel('work:c', { reason: 'r', caller: { type: 'human', operatorId: 't' } })
  assert.deepEqual(control.cancelRequest('work:c'), { reason: 'r', caller: { type: 'human', operatorId: 't' } })
  control.clearCancel('work:c')
  assert.equal(control.cancelRequest('work:c'), undefined)
})

/** Rounds of several processes taking one Work's lock at once; how many rounds had more than one winner. */
async function race(contenders: number, rounds: number, prepare: (raceDir: string) => void): Promise<number> {
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
  let doubleWins = 0
  for (let round = 0; round < rounds; round++) {
    const raceDir = mkdtempSync(join(dir, 'race-'))
    prepare(raceDir)
    const outcomes = await Promise.all(Array.from({ length: contenders }, () => new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', contender, raceDir], { stdio: ['ignore', 'pipe', 'inherit'] })
      let out = ''
      child.stdout.on('data', (d) => { out += d })
      child.on('close', () => resolve(out.trim()))
    })))
    if (outcomes.filter((o) => o === 'won').length > 1) doubleWins += 1
  }
  return doubleWins
}

test('hosts racing for a free lock never both win', async () => {
  assert.equal(await race(6, 10, () => undefined), 0)
})

test('two hosts racing for a stale lock never both win', async () => {
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout
  assert.equal(await race(2, 15, (raceDir) => writeFileSync(join(raceDir, 'work_race.lock'), dead)), 0)
})

test('three hosts racing for a stale lock never more than one wins', async () => {
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout
  assert.equal(await race(3, 15, (raceDir) => writeFileSync(join(raceDir, 'work_race.lock'), dead)), 0)
})

/** The lock's holder token for this process, as `FileControl` writes it. */
function liveToken(): string {
  const stat = readFileSync('/proc/self/stat', 'utf8')
  return `${process.pid} ${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`
}

test('a stale lock replaced by a live holder before the takeover reads it again survives', () => {
  const lock = join(dir, 'work_h.lock')
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout
  writeFileSync(lock, dead)
  // Another host replaces the stale lock after this one decided it was stale.
  class Replaced extends FileControl {
    protected override beforeRecheck(file: string): void {
      rmSync(file)
      writeFileSync(file, liveToken())
    }
  }
  assert.throws(() => new Replaced(dir).acquire('work:h'), WorkError)
  assert.equal(readFileSync(lock, 'utf8'), liveToken(), 'the live lock stays')
  assert.equal(existsSync(join(dir, 'work_h.takeover')), false, 'the mutex is released')
  assert.throws(() => new FileControl(dir).acquire('work:h'), WorkError)
})

test('a dead pid reused by a live process (wrong start time) is stale and taken over', { skip: !existsSync('/proc/self/stat') }, () => {
  const control = new FileControl(dir)
  writeFileSync(join(dir, 'work_i.lock'), `${process.pid} 1`)
  assert.equal(control.heldElsewhere('work:i'), false)
  const release = control.acquire('work:i')
  assert.equal(readFileSync(join(dir, 'work_i.lock'), 'utf8'), liveToken())
  release()
  assert.equal(existsSync(join(dir, 'work_i.lock')), false)
})

test('a pid-only lock of a live process stays held; release keeps a lock that is not ours', () => {
  const control = new FileControl(dir)
  writeFileSync(join(dir, 'work_j.lock'), String(process.pid))
  assert.equal(control.heldElsewhere('work:j'), true)
  rmSync(join(dir, 'work_j.lock'))
  const release = control.acquire('work:j')
  writeFileSync(join(dir, 'work_j.lock'), `${process.ppid} `)
  release()
  assert.equal(existsSync(join(dir, 'work_j.lock')), true)
})

test('a takeover mutex left by a dead process long ago does not block; a fresh one does', () => {
  const control = new FileControl(dir)
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout
  writeFileSync(join(dir, 'work_k.lock'), dead)
  const takeover = join(dir, 'work_k.takeover')
  writeFileSync(takeover, dead)
  assert.throws(() => control.acquire('work:k'), /is being run by another process/)
  const old = new Date(Date.now() - 60_000)
  utimesSync(takeover, old, old)
  control.acquire('work:k')()
  assert.equal(existsSync(takeover), false)
})
