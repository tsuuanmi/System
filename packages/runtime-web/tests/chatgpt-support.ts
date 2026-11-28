/**
 * Shared by the chatgpt-*.test.ts files: the fake site, the account and request builders and the scratch directory.
 * The tests are split over files so the runner runs them in separate processes at the same time (web-2).
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { Artifacts } from '@system/artifacts/contract'
import { FakeChatGpt, type FakeOptions } from '../../web-driver/tests/fake-chatgpt.ts'
import { CHROME, skipHeaded, shared, useSharedDisplay } from '../../../test-support/headed.ts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { CONVERSATION_KIND, TASK_KIND, conversationSchema, taskSchema, type Conversation, type WorkerRequest, type WorkerResult } from '@system/work'
import { CHROME_ARGS, IGNORED_DEFAULT_ARGS, chromeTmpdir, launch, launchTimeoutMs, parseBlocks, prepareProfile, stripLanguageLabel, stripLeaked, unblocked, profileLockPid, singleTab, webAttempt, webDefaults, webPrompt, webWorker, type WebAccount, type WebConfig } from '../src/chatgpt.ts'
import { startXvfb } from '../src/display.ts'
import { parseCookies, webLogin } from '../src/chatgpt-login.ts'

export const skip = skipHeaded
useSharedDisplay()
/** The file's shared display. */
export const sharedDisplay = () => shared.display!
export const root = mkdtempSync(join(tmpdir(), 'system-chatgpt-'))
const fakes: FakeChatGpt[] = []
/**
 * The fake site with these options, stopped after the file's tests. The Procedures never press Copy: the page shows the code widget
 * with its labelled header, as the live site does.
 */
export async function site(options: FakeOptions = {}): Promise<FakeChatGpt> {
  const fake = new FakeChatGpt({ thinkMs: 100, codeWidget: true, ...options })
  await fake.start()
  fakes.push(fake)
  return fake
}
after(async () => {
  await Promise.all(fakes.map((fake) => fake.stop()))
  rmSync(root, { recursive: true, force: true })
})

/** An answer that fills each of `slots` with a labelled block, as the prompt asks. */
export const blocks = (...slots: string[]) => ['Here is the **answer**.', '', ...slots.flatMap((slot) => ['```' + slot, `content of ${slot}`, 'second line', '```', ''])].join('\n')

let count = 0
const next = () => count++
export const memory = () => memoryArtifacts({ ...TASK_KIND, content: taskSchema }, { ...CONVERSATION_KIND, content: conversationSchema })

export function web(fake: FakeChatGpt, extra: Partial<WebConfig> = {}): WebConfig {
  return { ...webDefaults(join(root, `profile-${next()}`)), url: `${fake.origin}/`, executablePath: CHROME, timeouts: { load: 10, answer: 20, stable: 0.5 }, ...extra }
}
export const account = (config: WebConfig, extra: Partial<WebAccount> = {}): WebAccount => ({
  ref: 'web/chatgpt/default', capabilities: ['research'], command: CHROME, version: async () => 'fake', web: config, ...extra,
})
export function request(inputs: Record<string, string>, outputs: string[], signal = new AbortController().signal, tier?: string): WorkerRequest {
  return { workId: 'work:test', attemptId: `attempt:${next()}`, stepId: 'research', capabilities: tier ? ['research', `tier.${tier}`] : ['research'], inputs, outputs, signal }
}
export async function task(artifacts: Artifacts, instructions: string, note?: string): Promise<string> {
  const producer = { type: 'operator' as const, ref: 'tester' }
  const context = note === undefined ? [] : [(await artifacts.putBytes({ kind: 'file', schemaVersion: 1, data: new TextEncoder().encode(note), mediaType: 'text/plain', classification: 'local-private', producer })).id]
  return (await artifacts.put({ ...TASK_KIND, content: { instructions, ...(context.length ? { context } : {}) }, ...(context.length ? { inputs: context } : {}), classification: 'local-private', producer })).id
}
/** One attempt on a fake site with `options`; `answer` defaults to a block for each of `outputs`. */
export async function run(options: FakeOptions = {}, outputs = ['report'], more: { config?: Partial<WebConfig>; signal?: AbortSignal; tier?: string; extra?: Partial<WebAccount>; instructions?: string; note?: string; started?: (fake: FakeChatGpt) => void } = {}) {
  const fake = await site({ answer: blocks(...outputs), ...options })
  more.started?.(fake)
  const { artifacts } = memory()
  const worker = webWorker(account(web(fake, more.config), more.extra), artifacts, join(root, 'attempts'))
  const result = await worker.run(request({ task: await task(artifacts, more.instructions ?? 'Explain the fake topic.', more.note) }, outputs, more.signal, more.tier))
  return { artifacts, result, fake }
}
export const text = async (artifacts: Artifacts, id: string) => Buffer.from(await artifacts.readBytes(id)).toString('utf8')
export const conversationOf = (artifacts: Artifacts, result: WorkerResult, slot: 'outputs' | 'partial' = 'outputs') => {
  const read = artifacts.get(result[slot]!.conversation!)
  if (read.state !== 'stored') throw new Error('not stored')
  return { occurrences: read.occurrences, content: read.envelope.content as Conversation }
}
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
export const evidenceOf = async (artifacts: Artifacts, result: WorkerResult) => JSON.parse(await text(artifacts, result.partial!.evidence!))
