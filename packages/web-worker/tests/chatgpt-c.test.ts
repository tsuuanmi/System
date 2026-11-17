/**
 * chatgpt Worker, part 3: stage evidence, cancel, time limit and stand-in Chrome.
 * Split from the former chatgpt.test.ts (web-2): see chatgpt-support.ts.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Artifacts } from '@system/artifacts'
import { FakeChatGpt, type FakeOptions } from '../../web-driver/tests/fake-chatgpt.ts'
import { CHROME, skipHeaded } from '../../../test-support/headed.ts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { CONVERSATION_KIND, TASK_KIND, conversationSchema, taskSchema, type Conversation, type WorkerRequest, type WorkerResult } from '@system/work'
import { CHROME_ARGS, IGNORED_DEFAULT_ARGS, chromeTmpdir, launch, launchTimeoutMs, parseBlocks, prepareProfile, stripLanguageLabel, stripLeaked, unblocked, profileLockPid, singleTab, webAttempt, webDefaults, webPrompt, webWorker, type WebAccount, type WebConfig } from '../src/chatgpt.ts'
import { parseCookies, webLogin } from '../src/chatgpt-login.ts'
import { skip, root, site, memory, web, account, request, task, run, text, conversationOf, sleep, evidenceOf } from './chatgpt-support.ts'


// The stage chain of one attempt (evidence.ts): written as it happens, kept as partial output, and in the log on success.
const STAGES = ['launch', 'open', 'auth', 'mode', 'observe', 'power', 'insert', 'send', 'wait', 'read', 'close']

test('a launch that never returns fails at its own clock, and the evidence names the launch stage', { timeout: 30_000 }, async () => {
  const fake = await site()
  const config = web(fake, { timeouts: { load: 10, answer: 20, stable: 0.5, launch: 0.2 } })
  const { artifacts } = memory()
  const result = await webAttempt(account(config), artifacts, join(root, 'attempts'), request({ task: await task(artifacts, 'x') }, ['report']), () => new Promise(() => {}))
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /launch stage timed out after 0\.2 s/)
  const evidence = await evidenceOf(artifacts, result)
  assert.equal(evidence.launchTimeoutSeconds, 0.2)
  assert.equal(evidence.failedStage, 'launch')
  assert.deepEqual(evidence.stages.map((stage: { stage: string; status: string }) => [stage.stage, stage.status]), [['launch', 'failed'], ['close', 'ok']])
  assert.equal(evidence.promptSubmitted, false)
  assert.equal(evidence.uiMap.revision, '2026-10-11')
  assert.match(evidence.uiMap.hash, /^sha256:/)
})

test('a launch that fails is recorded as such; the record exists before Chrome starts', { timeout: 30_000 }, async () => {
  const fake = await site()
  const { artifacts } = memory()
  const attemptsDir = join(root, 'attempts')
  const req = request({ task: await task(artifacts, 'x') }, ['report'])
  let onDisk: { stages: unknown[]; chrome: string } | undefined
  const result = await webAttempt(account(web(fake)), artifacts, attemptsDir, req, async () => {
    onDisk = JSON.parse(readFileSync(join(attemptsDir, req.attemptId.replace(/[^a-z0-9-]/gi, '_'), 'evidence.json'), 'utf8'))
    throw new Error('Chrome exited\nwith a long log')
  })
  assert.deepEqual(onDisk!.stages.map((stage) => (stage as { stage: string }).stage), ['launch'], 'the launch stage was written before the launch ran')
  assert.equal(onDisk!.chrome, 'fake')
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /Chrome exited/)
  assert.equal((await evidenceOf(artifacts, result)).stages[0].error, 'Chrome exited')
})

test('a succeeded attempt reports its evidence and conversation beside its outputs', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result } = await run({}, ['report'])
  assert.equal(result.status, 'succeeded', result.reason)
  assert.deepEqual(Object.keys(result.partial ?? {}).sort(), ['conversation', 'evidence'])
  assert.equal(result.partial!.conversation, result.outputs.conversation)
  const evidence = await evidenceOf(artifacts, result)
  assert.ok(evidence.stages.some((stage: { stage: string }) => stage.stage === 'launch'))
  assert.equal(conversationOf(artifacts, result, 'partial').content.parts.length, 2)
})

// WW2-iv: the record is still chatgpt-web-evidence@1 (the canary reads it), and names no page logic: there is one.
test('the evidence names no page logic', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result } = await run({}, ['report'])
  assert.equal(result.status, 'succeeded', result.reason)
  const line = (await text(artifacts, result.log!)).trim().split('\n').at(-1)!
  const evidence = JSON.parse(line.slice(line.indexOf('{')))
  assert.equal(evidence.schema, 'chatgpt-web-evidence@1')
  assert.equal('procedures' in evidence, false)
})

// The Procedures never send a prompt that may have been sent again.
test('a send the page never shows is unknown: the attempt fails and nothing is resent', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result, fake } = await run({ dropSend: true }, ['report'])
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'send outcome unknown: not resent')
  assert.equal(fake.sent.length, 1)
  const evidence = await evidenceOf(artifacts, result)
  assert.equal(evidence.failedStage, 'send')
  assert.equal(evidence.promptSendAttempted, true)
  assert.equal(evidence.promptSubmitted, false)
})

test('a good attempt records every stage in order, with times, page counts, viewport and that the prompt was submitted', { skip, timeout: 60_000 }, async () => {
  const { artifacts, result } = await run({}, ['report'])
  assert.equal(result.status, 'succeeded', result.reason)
  const line = (await text(artifacts, result.log!)).trim().split('\n').at(-1)!
  const evidence = JSON.parse(line.slice(line.indexOf('{')))
  assert.deepEqual(evidence.stages.map((stage: { stage: string; status: string }) => [stage.stage, stage.status]), STAGES.map((stage) => [stage, 'ok']))
  assert.ok(evidence.stages.every((stage: { elapsedMs: number }) => stage.elapsedMs >= 0))
  assert.equal(evidence.promptSubmitted, true)
  assert.equal(evidence.launchTimeoutSeconds, 30)
  assert.equal(evidence.chrome, 'fake')
  assert.ok(evidence.pages.initial >= 1)
  assert.equal(evidence.pages.beforeNavigation, 1)
  assert.ok(evidence.viewport.width > 0 && evidence.viewport.height > 0)
})

test('a failure names its stage and keeps the page as evidence: screenshot, redacted DOM, URL, viewport, map version', { skip, timeout: 60_000 }, async () => {
  const cases = [
    ['auth', { signedIn: false }, {}, false],
    ['mode', { modeSwitch: false }, { timeouts: { load: 10, answer: 20, stable: 0.5, mode: 1 } }, false],
    ['wait', { thinkMs: 60_000 }, { timeouts: { load: 10, answer: 2, stable: 0.5 } }, true],
  ] as const
  for (const [stage, options, config, submitted] of cases) {
    const { artifacts, result } = await run(options, ['report'], { config })
    assert.equal(result.status, 'failed', stage)
    const evidence = await evidenceOf(artifacts, result)
    assert.equal(evidence.failedStage, stage)
    assert.equal(evidence.promptSubmitted, submitted, stage)
    assert.equal(evidence.stages.at(-1).stage, 'close', 'the browser is closed and that is recorded')
    const snapshot = JSON.parse(await text(artifacts, result.partial!.snapshot!))
    assert.match(snapshot.url, /^http:\/\/127\.0\.0\.1:\d+\//)
    assert.ok(snapshot.viewport.width > 0)
    assert.equal(snapshot.uiMap.revision, '2026-10-11')
    assert.ok(snapshot.dom.includes('<'))
    assert.ok(result.partial!.screenshot)
  }
})

test('a cancel and the time limit end Chrome with a close, and leave the evidence as partial output', { skip, timeout: 60_000 }, async () => {
  // Cancel once the page has the prompt, not after a fixed time: under load a fixed delay can come before the send.
  const stop = new AbortController()
  const cancelled = await run({ thinkMs: 60_000 }, ['report'], {
    signal: stop.signal,
    started: (fake) => { const poll = setInterval(() => { if (fake.sent.length) { clearInterval(poll); stop.abort() } }, 50) },
  })
  assert.equal(cancelled.result.status, 'cancelled')
  const timedOut = await run({ thinkMs: 60_000 }, ['report'], { extra: { attemptTimeoutMinutes: 0.1 } })
  assert.equal(timedOut.result.status, 'failed')
  for (const { artifacts, result, fake } of [cancelled, timedOut]) {
    const evidence = await evidenceOf(artifacts, result)
    assert.equal(evidence.stages.find((stage: { stage: string }) => stage.stage === 'close').status, 'ok')
    // The record says what the page received: the time limit may come before or after the send.
    if (fake.sent.length) assert.equal(evidence.promptSendAttempted, true)
    if (evidence.promptSubmitted) assert.ok(fake.sent.length > 0)
  }
  assert.equal(cancelled.fake.sent.length, 1)
})

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** A stand-in for a Chrome the launcher started: a process of its own group that holds the profile's lock, as Chrome's SingletonLock does. */
function standInChrome(profileDir: string): number {
  const child = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' })
  child.unref()
  mkdirSync(profileDir, { recursive: true })
  symlinkSync(`host-${child.pid}`, join(profileDir, 'SingletonLock'))
  return child.pid!
}

test('a launch that times out leaves no Chrome running: the process group it started is killed', { timeout: 30_000 }, async () => {
  const fake = await site()
  const config = web(fake, { timeouts: { load: 10, answer: 20, stable: 0.5, launch: 0.2 } })
  const { artifacts } = memory()
  let chrome = 0
  try {
    const result = await webAttempt(account(config), artifacts, join(root, 'attempts'), request({ task: await task(artifacts, 'x') }, ['report']), () => { chrome = standInChrome(config.profileDir); return new Promise(() => {}) })
    assert.equal(result.status, 'failed')
    assert.match(result.reason!, /launch stage timed out/)
    await sleep(200)
    assert.ok(!alive(chrome), 'the Chrome of the abandoned launch is gone')
  } finally {
    try { process.kill(chrome, 'SIGKILL') } catch { /* gone */ }
  }
})

test('a profile that another live Chrome holds is never launched, and that Chrome is left alone', { timeout: 30_000 }, async () => {
  const config = webDefaults(join(root, 'profile-held'))
  mkdirSync(config.profileDir, { recursive: true })
  symlinkSync(`host-${process.pid}`, join(config.profileDir, 'SingletonLock'))
  await assert.rejects(launch(config, undefined as never), new RegExp(`held by a running Chrome \\(pid ${process.pid}\\)`))
  const fake = await site()
  const { artifacts } = memory()
  const held = web(fake)
  const chrome = standInChrome(held.profileDir)
  try {
    const result = await webAttempt(account(held), artifacts, join(root, 'attempts'), request({ task: await task(artifacts, 'x') }, ['report']))
    assert.equal(result.status, 'failed')
    assert.match(result.reason!, /held by a running Chrome/)
    assert.ok(alive(chrome), 'the other Chrome was not touched')
  } finally {
    process.kill(chrome, 'SIGKILL')
  }
})

test('the close stage is ok only when the browser process has exited', { timeout: 30_000 }, async () => {
  const fake = await site()
  const config = web(fake)
  const { artifacts } = memory()
  let chrome = 0
  // A context whose close() returns while its process lives on.
  const context = { close: async () => {}, pages: () => [], on: () => {}, newPage: async () => { throw new Error('no page') } }
  try {
    const result = await webAttempt(account(config), artifacts, join(root, 'attempts'), request({ task: await task(artifacts, 'x') }, ['report']), async () => { chrome = standInChrome(config.profileDir); return context as never })
    assert.equal(result.status, 'failed')
    const evidence = await evidenceOf(artifacts, result)
    const close = evidence.stages.find((stage: { stage: string }) => stage.stage === 'close')
    assert.equal(close.status, 'failed')
    assert.match(close.error, /did not exit/)
    await sleep(200)
    assert.ok(!alive(chrome), 'the browser that outlived close() was killed')
  } finally {
    try { process.kill(chrome, 'SIGKILL') } catch { /* gone */ }
  }
})

test('a send is an attempt first and a submission only once the page shows the user turn', { skip, timeout: 60_000 }, async () => {
  const good = await run()
  const line = (await text(good.artifacts, good.result.log!)).trim().split('\n').at(-1)!
  const evidence = JSON.parse(line.slice(line.indexOf('{')))
  assert.deepEqual([evidence.promptSendAttempted, evidence.promptSubmitted], [true, true])
  // A launch that fails before any send: neither is claimed.
  const fake = await site()
  const { artifacts } = memory()
  const failed = await webAttempt(account(web(fake)), artifacts, join(root, 'attempts'), request({ task: await task(artifacts, 'x') }, ['report']), async () => { throw new Error('no chrome') })
  const before = await evidenceOf(artifacts, failed)
  assert.deepEqual([before.promptSendAttempted, before.promptSubmitted], [false, false])
})

test('a page that cannot be closed breaks the one-tab invariant loudly, and a late page counts only once closed', async () => {
  const stuck = { close: async () => { throw new Error('stuck') } }
  const context = { pages: () => [stuck], newPage: async () => ({ close: async () => {} }), on: () => {} }
  await assert.rejects(singleTab(context as never), /1 other page\(s\) could not be closed/)
})

test('a Chrome that took the profile during a failed launch is not the attempt\'s: it is never killed', { timeout: 30_000 }, async () => {
  const fake = await site()
  const config = web(fake)
  const { artifacts } = memory()
  // Started by a shell that has exited, so it is nobody's child here; this test signals only the pid it recorded.
  const foreign = Number(spawnSync('sh', ['-c', 'setsid sleep 300 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout)
  assert.ok(foreign > 0)
  try {
    const result = await webAttempt(account(config), artifacts, join(root, 'attempts'), request({ task: await task(artifacts, 'x') }, ['report']), async () => {
      mkdirSync(config.profileDir, { recursive: true })
      symlinkSync(`host-${foreign}`, join(config.profileDir, 'SingletonLock'))
      throw new Error('refused')
    })
    assert.equal(result.status, 'failed')
    await sleep(200)
    assert.ok(alive(foreign), 'the other Chrome was not touched')
  } finally {
    try { process.kill(foreign, 'SIGKILL') } catch { /* gone */ }
  }
})

test('a close with no browser process to check is not ok', { timeout: 30_000 }, async () => {
  const fake = await site()
  const { artifacts } = memory()
  const context = { close: async () => {}, pages: () => [], on: () => {}, newPage: async () => { throw new Error('no page') } }
  const result = await webAttempt(account(web(fake)), artifacts, join(root, 'attempts'), request({ task: await task(artifacts, 'x') }, ['report']), async () => context as never)
  const close = (await evidenceOf(artifacts, result)).stages.find((stage: { stage: string }) => stage.stage === 'close')
  assert.equal(close.status, 'failed')
  assert.match(close.error, /process was not identified/)
})

test('a late page that cannot be closed fails the one-tab invariant, before anything is opened', { timeout: 30_000 }, async () => {
  let arrive!: (page: unknown) => void
  const context = { pages: () => [], newPage: async () => ({ close: async () => {} }), on: (_event: string, fn: (page: unknown) => void) => { arrive = fn } }
  const tabs = await singleTab(context as never)
  tabs.check()
  arrive({ close: async () => { throw new Error('stuck') } })
  await sleep(20)
  assert.throws(() => tabs.check(), /1 late page\(s\) could not be closed; the one-tab invariant does not hold/)
  const fake = await site()
  const { artifacts } = memory()
  let gone = false
  const page = {
    close: async () => {}, setDefaultNavigationTimeout: () => {}, url: () => 'about:blank', screenshot: async () => { throw new Error('none') },
    evaluate: async () => { arrive({ close: async () => { throw new Error('stuck') } }); await sleep(20); return { width: 1, height: 1 } },
    goto: async () => { gone = true },
  }
  const result = await webAttempt(account(web(fake)), artifacts, join(root, 'attempts'), request({ task: await task(artifacts, 'x') }, ['report']), async () => ({ close: async () => {}, pages: () => [], on: (_event: string, fn: (page: unknown) => void) => { arrive = fn }, newPage: async () => page }) as never)
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /1 late page\(s\) could not be closed/)
  assert.equal(gone, false, 'the page was never navigated')
})

test('a failure in the open stage names that stage and its own limit, not the answer clock', { timeout: 30_000 }, async () => {
  const fake = await site()
  const { artifacts } = memory()
  const page = {
    close: async () => {}, setDefaultNavigationTimeout: () => {}, url: () => 'about:blank', screenshot: async () => { throw new Error('none') },
    evaluate: async () => ({ width: 1, height: 1 }),
    goto: async () => { throw Object.assign(new Error('page.goto: Timeout 60000ms exceeded.\nCall log:\n  - navigating'), { name: 'TimeoutError' }) },
  }
  const result = await webAttempt(account(web(fake, { timeouts: { load: 60, answer: 20, stable: 0.5 } })), artifacts, join(root, 'attempts'), request({ task: await task(artifacts, 'x') }, ['report']), async () => ({ close: async () => {}, pages: () => [], on: () => {}, newPage: async () => page }) as never)
  assert.equal(result.status, 'failed')
  assert.match(result.reason!, /: open: page\.goto timed out after 60 s$/)
  assert.doesNotMatch(result.reason!, /answer/)
})

