import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { acquireHostLock } from '../src/host-lock.ts'

const dir = mkdtempSync(join(tmpdir(), 'system-host-lock-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const home = (name: string) => { const path = join(dir, name); mkdirSync(path); return path }

test('a second lock on the same home is refused, naming the home', async () => {
  const first = await acquireHostLock(home('a'))
  await assert.rejects(acquireHostLock(join(dir, 'a')), /another Host already runs for .*\/a/)
  await first.release()
})

test('a lock on another home is not refused', async () => {
  const a = await acquireHostLock(home('b1'))
  const b = await acquireHostLock(home('b2'))
  await a.release()
  await b.release()
})

test('the home is canonical: a symlink to a held home is the same home', async () => {
  const real = home('c')
  symlinkSync(real, join(dir, 'c-link'))
  const first = await acquireHostLock(real)
  await assert.rejects(acquireHostLock(join(dir, 'c-link')), /another Host already runs/)
  await first.release()
})

test('after release the home can be taken at once', async () => {
  const first = await acquireHostLock(home('d'))
  await first.release()
  await (await acquireHostLock(join(dir, 'd'))).release()
})

test('a killed process releases the home by itself', async () => {
  const path = home('e')
  const script = `const { acquireHostLock } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/host-lock.ts')).href)})
    await acquireHostLock(${JSON.stringify(path)})
    console.log('ready')
    setInterval(() => {}, 1000)`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((ready, fail) => {
    child.once('error', fail)
    child.once('exit', (code) => fail(new Error(`the child exited early with ${code}`)))
    child.stdout.once('data', () => { child.removeAllListeners('exit'); ready() })
  })
  await assert.rejects(acquireHostLock(path), /another Host already runs/)
  const exited = new Promise((done) => child.once('exit', done))
  child.kill('SIGKILL')
  await exited
  await (await acquireHostLock(path)).release()
})

test('off Linux the refusal says so', async () => {
  await assert.rejects(acquireHostLock(home('f'), { platform: 'darwin' }), /needs Linux/)
})

test('a home that does not exist is refused, naming it', async () => {
  await assert.rejects(acquireHostLock(join(dir, 'missing')), /DSH_HOME .*missing does not exist/)
})
