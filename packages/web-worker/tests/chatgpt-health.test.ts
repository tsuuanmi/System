/**
 * The circuit breaker (WW6d) around real attempts on System 1's fake ChatGPT site: the state each outcome leaves in the Account's
 * `state.json`, a launch failure that leaves it alone, and the recheck, which opens the profile headed on its own Xvfb and sends
 * nothing. The state machine itself is in health.test.ts. Belongs to `test:web`.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { FakeChatGpt, type FakeOptions } from '../../web-driver/tests/fake-chatgpt.ts'
import { CHROME, skipHeaded } from '../../../test-support/headed.ts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { CONVERSATION_KIND, TASK_KIND, conversationSchema, taskSchema, type WorkerRequest } from '@system/work'
import { webDefaults, webWorker, type WebAccount, type WebConfig } from '../src/chatgpt.ts'
import { AccountHealth } from '../src/health.ts'
import { recheck } from '../src/recheck.ts'

const skip = skipHeaded
const root = mkdtempSync(join(tmpdir(), 'system-chatgpt-health-'))
const fakes: FakeChatGpt[] = []
after(async () => {
  await Promise.all(fakes.map((fake) => fake.stop()))
  rmSync(root, { recursive: true, force: true })
})

let count = 0
async function site(options: FakeOptions = {}): Promise<FakeChatGpt> {
  const fake = new FakeChatGpt({ thinkMs: 100, copied: (markdown) => markdown, answer: '```report\nthe report\n```', ...options })
  await fake.start()
  fakes.push(fake)
  return fake
}
/** An Account on `fake` with its health, its directory being its profile as in the Host. */
function account(fake: FakeChatGpt, extra: Partial<WebConfig> = {}) {
  const dir = join(root, `account-${count++}`)
  const web: WebConfig = { ...webDefaults(dir), url: `${fake.origin}/`, executablePath: CHROME, timeouts: { load: 10, answer: 20, stable: 0.5 }, ...extra }
  const notices: string[] = []
  const health = new AccountHealth(dir, 'chatgpt-web/second', { log: (line) => notices.push(line) })
  const acc: WebAccount = { ref: 'chatgpt-web/second', capabilities: ['research'], command: CHROME, version: async () => 'fake', web, health }
  return { web, health, notices, acc, dir }
}
const attempt = async (acc: WebAccount, launcher?: Parameters<typeof webWorker>[3]) => {
  const { artifacts } = memoryArtifacts({ ...TASK_KIND, content: taskSchema }, { ...CONVERSATION_KIND, content: conversationSchema })
  const producer = { type: 'operator' as const, ref: 'tester' }
  const task = (await artifacts.put({ ...TASK_KIND, content: { instructions: 'Explain.' }, classification: 'local-private', producer })).id
  const request: WorkerRequest = { workId: 'work:test', attemptId: `attempt:${count++}`, stepId: 'research', capabilities: ['research'], inputs: { task }, outputs: ['report'], signal: new AbortController().signal }
  return webWorker(acc, artifacts, join(root, 'attempts'), launcher).run(request)
}
const saved = (dir: string) => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))

test('a sign-in wall quarantines the Account: needs-sign-in on disk, one notice, and the Worker offers nothing', { skip, timeout: 60_000 }, async () => {
  const { acc, health, notices, dir } = account(await site({ signedIn: false }))
  const worker = webWorker(acc, memoryArtifacts().artifacts, join(root, 'attempts'))
  assert.deepEqual(worker.capabilities, ['research'])
  const result = await attempt(acc)
  assert.equal(result.status, 'failed')
  assert.equal(health.record.state, 'needs-sign-in')
  assert.equal(saved(dir).state, 'needs-sign-in')
  assert.equal(notices.length, 1)
  assert.deepEqual(worker.capabilities, [])
})

test('a challenge quarantines the Account as challenged', { skip, timeout: 60_000 }, async () => {
  const { acc, health, dir } = account(await site({ captcha: true }))
  await attempt(acc)
  assert.equal(health.record.state, 'challenged')
  assert.equal(saved(dir).state, 'challenged')
})

test("the site's own error answer cools the Account down, and a success afterwards clears it", { skip, timeout: 90_000 }, async () => {
  const fake = await site({ loadFailure: true })
  const { acc, health } = account(fake)
  const result = await attempt(acc)
  assert.equal(result.reason, 'site error: the answer did not load (retryable)')
  assert.equal(health.record.state, 'cooling')
  assert.equal(health.record.consecutive, 1)
  // A good answer clears the cooldown and the count of errors.
  const good = await site()
  const fresh = account(good)
  fresh.health.failure({ failedStage: 'wait', reason: 'site error: the answer did not load', reachedSite: true })
  assert.equal((await attempt(fresh.acc)).status, 'succeeded')
  assert.equal(fresh.health.record.state, 'ready')
  assert.equal(fresh.health.record.consecutive, 0)
  assert.ok(fresh.health.record.lastSuccess)
})

test('a launch that fails is the Host\'s: the Account keeps its state', { skip, timeout: 60_000 }, async () => {
  const { acc, health, notices } = account(await site())
  const result = await attempt(acc, async () => { throw new Error('Timeout 30000ms exceeded: launchPersistentContext') })
  assert.equal(result.status, 'failed')
  assert.equal(health.record.state, 'ready')
  assert.deepEqual(notices, [])
})

test('recheck passes on a signed-in site, sends nothing and returns a quarantined Account to ready', { skip, timeout: 90_000 }, async () => {
  const fake = await site()
  const { acc, health, web, notices, dir } = account(fake)
  health.failure({ failedStage: 'auth', reason: 'chatgpt-web: signed out', reachedSite: true })
  assert.equal(health.record.state, 'needs-sign-in')
  const report = await recheck(web, health)
  assert.deepEqual({ ready: report.ready, state: report.state }, { ready: true, state: 'ready' })
  assert.equal(fake.sent.length, 0)
  assert.equal(saved(dir).state, 'ready')
  assert.match(notices.at(-1)!, /ready again: the recheck passed/)
  assert.equal(webWorker(acc, memoryArtifacts().artifacts, join(root, 'attempts')).capabilities.length, 1)
})

test('recheck fails on a sign-in wall or a challenge, and the Account stays in quarantine', { skip, timeout: 90_000 }, async () => {
  for (const [options, state] of [[{ signedIn: false }, 'needs-sign-in'], [{ captcha: true }, 'challenged']] as const) {
    const fake = await site(options)
    const { health, web } = account(fake)
    health.failure({ failedStage: 'auth', reason: state === 'challenged' ? 'challenge' : 'signed out', reachedSite: true })
    const report = await recheck(web, health)
    assert.equal(report.ready, false)
    assert.equal(health.record.state, state)
    assert.match(report.detail, state === 'challenged' ? /challenge/ : /signed out|sign-in/)
    assert.equal(fake.sent.length, 0)
  }
})

test('recheck of a profile a running Chrome holds is refused and leaves the state alone', { skip, timeout: 60_000 }, async () => {
  const { health, web } = account(await site())
  health.failure({ failedStage: 'auth', reason: 'signed out', reachedSite: true })
  const before = { ...health.record }
  const report = await recheck(web, health, { launcher: async () => { throw new Error('the profile is held by a running Chrome (pid 1); not launching on it') } })
  assert.equal(report.ready, false)
  assert.match(report.detail, /held by a running Chrome/)
  assert.deepEqual(health.record, before)
})
