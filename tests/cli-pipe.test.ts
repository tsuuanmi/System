/**
 * Item pipe-1: a command's output is whole when stdout is a pipe whose reader is slow, and a reader that
 * closes early does not make the command fail or hang. Through a real Host on a throwaway home.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { VERSION, connectHello } from '../packages/host/src/index.ts'
import { repo, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-pipe')
const home = cli.home
const entry = join(repo, 'bin', 'system')
const system = (...args: string[]) => cli.run(args)

before(async () => {
  assert.equal(system('init').status, 0)
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: verifiers
  disabled: true
- id: effects
  disabled: true
- id: fakes
  disabled: false
  config:
    workers: [repo.write]
`)
  await cli.start()
})

after(async () => {
  await cli.stop()
  rmSync(home, { recursive: true, force: true })
})

/** Run `bin/system <args>` with stdout a pipe nobody reads for `delayMs`; resolves what then arrives and the status. */
function slowReader(args: string[], delayMs: number): Promise<{ bytes: Buffer; code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env: cli.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ bytes: Buffer.concat(chunks), code, stderr }))
    setTimeout(() => child.stdout.on('data', (d: Buffer) => chunks.push(d)), delayMs)
  })
}

test('artifact cat of 200 KiB into a slow pipe delivers every byte', async () => {
  const data = randomBytes(200 * 1024)
  const file = join(home, 'big.bin')
  writeFileSync(file, data)
  const put = system('artifact', 'put', file)
  assert.equal(put.status, 0, put.stderr)
  const got = await slowReader(['artifact', 'cat', put.stdout.trim()], 1000)
  assert.equal(got.code, 0, got.stderr)
  assert.equal(got.bytes.length, data.length)
  assert.equal(createHash('sha256').update(got.bytes).digest('hex'), createHash('sha256').update(data).digest('hex'))
})

/** Enough Works admitted (not run), straight through the Host's socket, that `work list` is far over 64 KiB. */
async function manyWorks(): Promise<string> {
  const client = await connectHello(cli.socket, { version: VERSION, caller: { type: 'human', operatorId: 'tester' }, retry: 5_000 })
  try {
    for (let i = 0; i < 900; i += 1) await client.call('work.submit', { capabilities: ['repo.write'], run: false })
  } finally {
    client.close()
  }
  const listed = system('work', 'list')
  assert.equal(listed.status, 0, listed.stderr)
  assert.ok(listed.stdout.length > 65_536, `the list is ${listed.stdout.length} bytes`)
  return listed.stdout
}

test('work list over 64 KiB into a slow pipe arrives whole', async () => {
  const whole = await manyWorks()
  const got = await slowReader(['work', 'list'], 1000)
  assert.equal(got.code, 0, got.stderr)
  assert.equal(got.bytes.toString('utf8'), whole)
})

test('a reader that closes the pipe early ends the command quietly, with 141, the status of a Unix tool killed by SIGPIPE', async () => {
  await manyWorks()
  const got = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry, 'work', 'list'], { env: cli.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.stdout.once('data', () => child.stdout.destroy())
    child.on('error', reject)
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the command hangs after its reader closed')) }, 30_000)
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stderr }) })
  })
  assert.equal(got.stderr, '')
  assert.equal(got.code, 141)
})
