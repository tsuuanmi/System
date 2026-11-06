/**
 * An `AppHost` over the Host's socket: every Work, Artifact, credential and
 * Worker call of the CLI becomes one JSON-RPC call to the matching operation
 * (see the API reference of @system/host). The CLI reads files itself and
 * sends their contents.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Envelope, ReadResult } from '@system/artifacts'
import type { Asserted, ConversationParts, WorkRecord, WorkState } from '@system/work'
// By path, not by package: declaring @system/host here would change the lockfile.
import { MAX_FRAME, NotAnswering, type Client } from '../../host/lib/index.js'
import type { AppHost, Followed, FollowOptions, WorkCommands } from './cli.ts'
import { caller } from './io.ts'

/** How often `work.events` is asked while following a Work (PROP-0004 C13). */
export const POLL_MS = 1000

const FINISHED = new Set(['succeeded', 'failed', 'held', 'cancelled'])
const CLASSIFICATIONS = ['public', 'operator-shared', 'local-private']
const ARTIFACT_ID = /^sha256:[0-9a-f]{64}$/

export interface Remote {
  /** A connection that has said `host.hello` as `caller`. */
  open(caller: { type: 'human' | 'agent'; operatorId: string }): Promise<Client>
  /** Notes for the operator, such as that a Work was left running. */
  err(text: string): void
}

/** A call that changes something carries a fresh `commandId`; after a timeout it is sent once more with the same one, so the Host does it once. */
async function mutate(client: Client, method: string, params: object): Promise<any> {
  const commandId = randomUUID()
  try {
    return await client.call(method, { ...params, commandId })
  } catch (error) {
    if (!(error instanceof NotAnswering)) throw error
    return client.call(method, { ...params, commandId })
  }
}

const base64 = (data: Uint8Array): string => Buffer.from(data).toString('base64')

export function remoteHost(remote: Remote): AppHost {
  let session: Promise<Client> | undefined
  const link = (): Promise<Client> => (session ??= remote.open(caller()))
  const read = async (method: string, params?: object): Promise<any> => (await link()).call(method, params)
  const change = async (method: string, params: object): Promise<any> => mutate(await link(), method, params)

  /** Poll `work.events` until the Work is terminal. Ctrl-C detaches, or cancels first with `cancelOnInterrupt`. */
  async function follow(workId: string, options: FollowOptions = {}): Promise<Followed> {
    let after = -1
    let cancelling: Promise<unknown> | undefined
    let interrupt!: () => void
    const interrupted = new Promise<'interrupted'>((resolve) => { interrupt = () => resolve('interrupted') })
    const onInterrupt = () => {
      if (options.cancelOnInterrupt && !cancelling) {
        cancelling = change('work.cancel', { workId, reason: 'cancelled by the operator: interrupted' })
        // A failure is raised when the Work has ended, below.
        cancelling.catch(() => {})
        return
      }
      interrupt()
    }
    process.on('SIGINT', onInterrupt)
    const detach = (): Followed => {
      remote.err(`detached; ${workId} goes on in the Host\n`)
      return 'detached'
    }
    try {
      for (;;) {
        const polled = await Promise.race([read('work.events', { workId, after }) as Promise<{ events: { seq: number }[]; status: string }>, interrupted])
        if (polled === 'interrupted') return detach()
        after = polled.events.at(-1)?.seq ?? after
        if (FINISHED.has(polled.status)) {
          await cancelling
          return read('work.show', { workId })
        }
        const slept = await Promise.race([new Promise<'slept'>((done) => setTimeout(() => done('slept'), POLL_MS)), interrupted])
        if (slept === 'interrupted') return detach()
      }
    } finally {
      process.off('SIGINT', onInterrupt)
    }
  }

  const work: WorkCommands = {
    noHost: async () => {},
    admitFile: (path, input) => change('work.submit', { workflow: readFileSync(path, 'utf8'), input }),
    admitTask: (capabilities, input) => change('work.submit', { capabilities, input }),
    async run(workId, options) {
      await change('work.run', { workId })
      return follow(workId, options)
    },
    get: (workId) => read('work.show', { workId }) as Promise<WorkRecord>,
    list: () => read('work.list'),
    replay: (workId) => read('work.replay', { workId }) as Promise<{ state: WorkState; matches: boolean }>,
    cancel: (workId, reason) => change('work.cancel', { workId, reason }),
    async decide(workId, decision, operator, reason) {
      // A decision is a human's: its own connection says so, whoever the other calls are.
      const human = await remote.open({ type: 'human', operatorId: operator })
      try {
        await mutate(human, 'approval.decide', { workId, decision, reason })
      } finally {
        human.close()
      }
      return follow(workId)
    },
    async retry(workId, worker, reason, step, options) {
      await change('work.retry', { workId, worker, reason, step })
      return follow(workId, options)
    },
    wait: (workId) => follow(workId),
    async newTask(instructions, repository, ref, context) {
      return read('task.new', { instructions, repository: repository && resolve(repository), ref, context })
    },
    async addConversation(parts: ConversationParts, asserted: Asserted, supersedes: string[]) {
      const part = (p: { name: string; data: Uint8Array; mediaType: string }) => ({ name: p.name, data: base64(p.data), mediaType: p.mediaType })
      // The CLI has already refused what the preview warned about, unless the operator accepted it.
      return read('conversation.add', {
        parts: { response: part(parts.response), ...(parts.prompt ? { prompt: part(parts.prompt) } : {}), attachments: (parts.attachments ?? []).map(part) },
        asserted, supersedes, acceptWarnings: true,
      })
    },
  }

  const unavailable = (what: string) => () => { throw new Error(`${what} runs in the process that boots DSH, not in the thin client`) }
  return {
    hasService: unavailable('the doctor'),
    dshVersion: unavailable('the doctor'),
    probeStorage: unavailable('the doctor'),
    probeHost: unavailable('the doctor'),
    runHost: unavailable('the Host'),
    work: () => work,
    artifacts: () => ({
      async putFile(path: string, mediaType: string, classification: string): Promise<Envelope> {
        if (!CLASSIFICATIONS.includes(classification)) throw new Error(`unknown classification ${classification}`)
        const data = base64(readFileSync(path))
        if (data.length > MAX_FRAME - 1024) throw new Error(`${path} is too large to send to the Host (${data.length} bytes in base64; a frame holds ${MAX_FRAME})`)
        return read('artifact.put', { data, mediaType, classification })
      },
      async get(id: string): Promise<ReadResult> {
        if (!ARTIFACT_ID.test(id)) throw new Error(`not an Artifact ID: ${id}`)
        return read('artifact.show', { id })
      },
      async readBytes(id: string) {
        if (!ARTIFACT_ID.test(id)) throw new Error(`not an Artifact ID: ${id}`)
        return Buffer.from((await read('artifact.cat', { id })).data, 'base64')
      },
    }),
    credentials: () => ({
      set: async (name, value) => { await read('credentials.set', { name, value }) },
      describe: async (name) => (await read('credentials.status', { names: [name] }))[0],
    }),
    workers: () => read('workers.list'),
  }
}
