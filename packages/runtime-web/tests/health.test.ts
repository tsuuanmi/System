/**
 * The per-Account circuit breaker (WW6d): the transitions from attempt outcomes, the Host's own timeouts that never count against an
 * Account, one notice per state change, the state surviving a restart, and routing that skips an Account in quarantine. No browser:
 * the page-driven tests (an attempt on the fake site, the recheck) are in chatgpt-health.test.ts.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Capabilities, type WorkerPort } from '@system/work'
import { AccountHealth, classify, healthWorker, unavailableReason, type HealthSettings } from '../src/health.ts'

const root = mkdtempSync(join(tmpdir(), 'system-health-'))
after(() => rmSync(root, { recursive: true, force: true }))

let count = 0
/** The clock's time as the Host prints it: local, hours and minutes. */
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const START = Date.parse('2026-11-08T05:10:00')
const SETTINGS: HealthSettings = { cooldownSeconds: [120, 300] }
function health(dir = join(root, `account-${count++}`)) {
  const clock = { now: START }
  const notices: string[] = []
  const make = () => new AccountHealth(dir, 'web/chatgpt/second', { now: () => clock.now, log: (line) => notices.push(line), settings: SETTINGS })
  return { health: make(), make, clock, notices, dir }
}
const failed = (reason: string, failedStage = 'wait') => ({ failedStage, reason, reachedSite: true })

test('classify: a sign-in wall, a login page and "Session ended, invalid_state" need a sign-in', () => {
  assert.equal(classify(failed('web/chatgpt/second: chatgpt-web: signed out; sign in again (system workers login)', 'auth')), 'needs-sign-in')
  assert.equal(classify(failed('web/chatgpt/second: chatgpt-web: signed out while the Chat/Work switch was awaited', 'mode')), 'needs-sign-in')
  assert.equal(classify(failed('web/chatgpt/second: chatgpt-web: unknown sign-in page (/auth/login); use the remote login', 'auth')), 'needs-sign-in')
  assert.equal(classify(failed('Session ended, invalid_state', 'auth')), 'needs-sign-in')
})

test('classify: a Cloudflare or CAPTCHA challenge is challenged, before the login words its message also holds', () => {
  assert.equal(classify(failed('web/chatgpt/second: chatgpt-web: the site shows a challenge (Verify you are human); pass it in the login profile (system workers login) and Save', 'auth')), 'challenged')
  assert.equal(classify(failed('blocked by Cloudflare', 'open')), 'challenged')
  assert.equal(classify(failed('a CAPTCHA is shown', 'auth')), 'challenged')
})

test('classify: a site error or a suspected rate limit is a cooldown', () => {
  assert.equal(classify(failed('web/chatgpt/second: site error: the answer did not load (retryable)')), 'cooling')
  assert.equal(classify(failed("web/chatgpt/second: chatgpt-web: the site shows its own error page instead of the app; nothing was sent", 'auth')), 'cooling')
  assert.equal(classify(failed('You are sending too many requests; rate limit', 'send')), 'cooling')
})

test('classify: other failures, and a bare timeout, say nothing about the Account', () => {
  assert.equal(classify(failed('web/chatgpt/second: the wait stage timed out after 900 s: x')), undefined)
  assert.equal(classify(failed('web/chatgpt/second wrote no output block for report')), undefined)
  assert.equal(classify(failed('attempt exceeded its time limit of 60 minutes', 'wait')), undefined)
})

test('classify: a failure attributed to the Host never counts', () => {
  // Any error before the browser reached the Site, even one that would otherwise read as a sign-in wall.
  assert.equal(classify({ failedStage: 'launch', reason: 'web/chatgpt/second: launch: signed out', reachedSite: false }), undefined)
  assert.equal(classify({ failedStage: undefined, reason: 'the prompt is 300000 bytes', reachedSite: false }), undefined)
  // A goto timeout while the Host is busy; with a quiet Host the same timeout is only unclassified (not a rate limit).
  assert.equal(classify({ failedStage: 'open', reason: 'web/chatgpt/second: open: page.goto: Timeout 10000ms exceeded', reachedSite: true, hostBusy: true }), undefined)
  assert.equal(classify({ failedStage: 'open', reason: 'web/chatgpt/second: open: page.goto: Timeout 10000ms exceeded', reachedSite: true }), undefined)
  // A real sign-in wall is the Account's even while the Host is busy.
  assert.equal(classify({ ...failed('chatgpt-web: signed out', 'auth'), hostBusy: true }), 'needs-sign-in')
})

test('a new Account is ready, with no file until something happens', () => {
  const { health: h, dir } = health()
  assert.equal(h.record.state, 'ready')
  assert.equal(h.unavailable(), undefined)
  assert.throws(() => statSync(join(dir, 'state.json')))
})

test('a sign-in wall quarantines at once: unavailable with the action, and nothing but a recheck leads out', () => {
  const { health: h, clock, notices } = health()
  h.failure(failed('chatgpt-web: signed out', 'auth'))
  assert.equal(h.record.state, 'needs-sign-in')
  assert.equal(h.unavailable(), `needs sign-in since ${hhmm(START)}: run \`system workers login web/chatgpt/second --remote\`, then \`system workers recheck web/chatgpt/second\``)
  clock.now += 24 * 3600_000
  assert.match(h.unavailable()!, new RegExp(`^needs sign-in since ${hhmm(START)}`))
  h.success()
  assert.equal(h.record.state, 'needs-sign-in', 'a success of another attempt does not clear a quarantine')
  assert.equal(notices.length, 1)
  h.recheckPassed()
  assert.equal(h.record.state, 'ready')
  assert.equal(h.unavailable(), undefined)
})

test('a challenge quarantines at once, with its own action', () => {
  const { health: h } = health()
  h.failure(failed('the site shows a challenge (Verify you are human)', 'auth'))
  assert.equal(h.record.state, 'challenged')
  assert.match(h.unavailable()!, new RegExp(`^challenged since ${hhmm(START)}: .*system workers login web/chatgpt/second --remote.*system workers recheck web/chatgpt/second`))
})

test('a site error cools down 2 minutes, then 5 after a consecutive one, and a success clears it; the cooldown ends by itself', () => {
  const { health: h, clock } = health()
  h.failure(failed('site error: the answer did not load (retryable)'))
  assert.equal(h.record.state, 'cooling')
  assert.equal(h.record.cooldownUntil, new Date(clock.now + 120_000).toISOString())
  assert.equal(h.unavailable(), `cooling down since ${hhmm(START)} after a site error, until ${hhmm(START + 120_000)}; it ends by itself`)
  clock.now += 119_000
  assert.ok(h.unavailable())
  clock.now += 1_000
  assert.equal(h.unavailable(), undefined, 'ready again at cooldownUntil')
  h.failure(failed('site error: the answer did not load (retryable)'))
  assert.equal(h.record.cooldownUntil, new Date(clock.now + 300_000).toISOString())
  clock.now += 300_000
  h.failure(failed('site error: the answer did not load (retryable)'))
  assert.equal(h.record.cooldownUntil, new Date(clock.now + 300_000).toISOString(), 'the last cooldown repeats')
  h.success()
  assert.equal(h.record.state, 'ready')
  assert.equal(h.record.consecutive, 0)
  assert.equal(h.record.lastSuccess, new Date(clock.now).toISOString())
  h.failure(failed('site error: the answer did not load (retryable)'))
  assert.equal(h.record.cooldownUntil, new Date(clock.now + 120_000).toISOString(), 'after a success it starts at 2 minutes again')
})

test('a failure that says nothing, a Host timeout and a cancel leave the state alone', () => {
  const { health: h, notices } = health()
  h.failure(failed('web/chatgpt/second: the wait stage timed out after 900 s'))
  h.failure({ failedStage: 'launch', reason: 'launch timed out', reachedSite: false })
  h.failure({ failedStage: 'open', reason: 'open: page.goto: Timeout 60000ms exceeded', reachedSite: true, hostBusy: true })
  assert.equal(h.record.state, 'ready')
  assert.equal(h.record.consecutive, 0)
  assert.deepEqual(notices, [])
  const { health: sick } = health()
  sick.failure(failed('signed out', 'auth'))
  const before = { ...sick.record }
  sick.failure({ failedStage: 'launch', reason: 'x', reachedSite: false })
  assert.deepEqual(sick.record, before)
})

test('one notice per state change: a log line and lastNotice; the same state seen again gives none', () => {
  const { health: h, notices, clock } = health()
  h.failure(failed('chatgpt-web: signed out', 'auth'))
  h.failure(failed('Session ended, invalid_state', 'auth'))
  h.failure(failed('chatgpt-web: signed out', 'auth'))
  assert.equal(notices.length, 1)
  assert.match(notices[0]!, new RegExp(`^web/chatgpt/second: needs sign-in since ${hhmm(START)}: run .system workers login`))
  assert.equal(h.record.lastNotice?.state, 'needs-sign-in')
  assert.equal(h.record.lastNotice?.at, new Date(clock.now).toISOString())
  assert.equal(h.record.lastNotice?.text, notices[0]!.replace(/^web\/chatgpt\/second: /, ''))
  // A different state is a change, and so is the return to ready.
  h.failure(failed('the site shows a challenge', 'auth'))
  assert.equal(notices.length, 2)
  h.recheckPassed()
  assert.equal(notices.length, 3)
  assert.match(notices[2]!, /ready again/)
  h.recheckPassed()
  assert.equal(notices.length, 3)
})

test('a second consecutive site error is the same state: a longer cooldown, no new notice; the expiry is noticed once', () => {
  const { health: h, notices, clock } = health()
  h.failure(failed('site error: the answer did not load (retryable)'))
  h.failure(failed('site error: the answer did not load (retryable)'))
  assert.equal(notices.length, 1)
  clock.now += 300_000
  assert.equal(h.unavailable(), undefined)
  assert.equal(h.unavailable(), undefined)
  assert.equal(notices.length, 2)
  assert.match(notices[1]!, /ready again after its cooldown/)
})

test('the state is a durable, owner-only file in the Account directory and survives a restart', () => {
  const { health: h, make, dir, clock } = health()
  h.failure(failed('chatgpt-web: signed out', 'auth'))
  const file = join(dir, 'state.json')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.state, 'needs-sign-in')
  assert.equal(saved.since, new Date(clock.now).toISOString())
  const again = make()
  assert.equal(again.record.state, 'needs-sign-in')
  assert.match(again.unavailable()!, new RegExp(`^needs sign-in since ${hhmm(START)}`))
  assert.equal(again.record.lastNotice?.state, 'needs-sign-in')
  // The same state seen after the restart gives no new notice.
  const lines: string[] = []
  const third = new AccountHealth(dir, 'web/chatgpt/second', { now: () => clock.now, log: (l) => lines.push(l), settings: SETTINGS })
  third.failure(failed('chatgpt-web: signed out', 'auth'))
  assert.deepEqual(lines, [])
})

test('a cooldown survives a restart, and a corrupt or foreign file is a fresh ready Account that is rewritten', () => {
  const { health: h, make, dir, clock } = health()
  h.failure(failed('site error: the answer did not load (retryable)'))
  assert.ok(make().unavailable())
  clock.now += 120_000
  assert.equal(make().unavailable(), undefined)
  writeFileSync(join(dir, 'state.json'), '{not json')
  assert.equal(make().record.state, 'ready')
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ schema: 'other', state: 'challenged' }))
  assert.equal(make().record.state, 'ready')
})

test('routing skips an Account in quarantine and uses the other; it is back when the Account is ready', () => {
  const a = health()
  const b = health()
  const port = (ref: string, h: AccountHealth): WorkerPort => healthWorker({ ref, capabilities: ['research'], run: async () => { throw new Error('not run') } }, h)
  const capabilities = new Capabilities()
  capabilities.registerWorker(port('web/chatgpt/default', a.health))
  capabilities.registerWorker(port('web/chatgpt/second', b.health))
  assert.equal(capabilities.routeWorker(['research']).selected?.ref, 'web/chatgpt/default')
  a.health.failure(failed('chatgpt-web: signed out', 'auth'))
  assert.equal(capabilities.routeWorker(['research']).selected?.ref, 'web/chatgpt/second')
  assert.ok(capabilities.available().workers.has('research'))
  b.health.failure(failed('the site shows a challenge', 'auth'))
  assert.equal(capabilities.routeWorker(['research']).selected, undefined)
  assert.equal(capabilities.available().workers.has('research'), false)
  // Still registered (a pinned Work names it), and the other's slots and run are untouched.
  assert.deepEqual(capabilities.workerRefs(), ['web/chatgpt/default', 'web/chatgpt/second'])
  a.health.recheckPassed()
  assert.equal(capabilities.routeWorker(['research']).selected?.ref, 'web/chatgpt/default')
})

test('unavailableReason is the line `system workers` shows', () => {
  const { health: h } = health()
  assert.equal(unavailableReason(h), undefined)
  h.failure(failed('chatgpt-web: signed out', 'auth'))
  assert.match(unavailableReason(h)!, new RegExp(`^needs sign-in since ${hhmm(START)}`))
})
