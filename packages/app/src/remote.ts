/**
 * A `ClientHost` over the Host's socket: every Work, Artifact, credential and
 * Worker call of the CLI becomes one JSON-RPC call to the matching operation
 * (see the API reference of @system/host). The CLI reads files itself and
 * sends their contents.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { CLASSIFICATIONS, CONTENT_ID_RE, type Envelope, type ReadResult } from '@system/artifacts'
import { TERMINAL, parseWorkflow, type Asserted, type Caller, type ConversationParts, type GoalView, type WorkRecord, type WorkState } from '@system/work'
// By path, not by package: declaring @system/host here would change the lockfile.
import { MAX_FRAME, NotAnswering, NotRunning, fitsFrame, type Client } from '../../host/lib/index.js'
import type { ClientHost, Followed, FollowOptions, WorkCommands } from './cli.ts'
import { caller } from './io.ts'

/** How often `work.events` is asked while following a Work (PROP-0004 C13). */
export const POLL_MS = 1000

/** How long `workers.login` may take: a manual sign-in waits up to ten minutes. */
const LOGIN_TIMEOUT = 11 * 60_000
/** How long `workers.recheck` may take: a Chrome start and the page's own clocks. */
const RECHECK_TIMEOUT = 3 * 60_000
/** How long `workers.loginWait` may take: the viewer's session is 15 minutes, then the check. */
const REMOTE_LOGIN_TIMEOUT = 17 * 60_000


export interface Remote {
  /** A connection that has said `host.hello` as `caller`. */
  open(caller: Caller): Promise<Client>
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

/** The Workflow files `text` uses (Sub-workflows), and the ones they use, read from `dir` once each, by name. A file that does not parse is sent as it is: the Host says why. */
export function usedFiles(text: string, dir: string, found: Record<string, string> = {}): Record<string, string> {
  let names: string[]
  try {
    names = parseWorkflow(text).steps.flatMap((s) => ('uses' in s ? [s.uses] : []))
  } catch {
    return found
  }
  for (const name of names) {
    if (Object.hasOwn(found, name)) continue
    found[name] = readFileSync(join(dir, name), 'utf8')
    usedFiles(found[name], dir, found)
  }
  return found
}

export function remoteHost(remote: Remote): ClientHost {
  let session: Promise<Client> | undefined
  const link = (): Promise<Client> => (session ??= remote.open(caller()))
  const read = async (method: string, params?: object): Promise<any> => (await link()).call(method, params)
  /** A read that outlives a Host's swap for new code: a connection it closed is opened again (`open` waits for the next Host), once. */
  const reread = async (method: string, params?: object): Promise<any> => {
    try {
      return await read(method, params)
    } catch (error) {
      if (!(error instanceof NotRunning)) throw error
      session = undefined
      return read(method, params)
    }
  }
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
        const polled = await Promise.race([reread('work.events', { workId, after }) as Promise<{ events: { seq: number }[]; status: WorkState['status'] }>, interrupted])
        if (polled === 'interrupted') return detach()
        after = polled.events.at(-1)?.seq ?? after
        if (TERMINAL.has(polled.status)) {
          await cancelling
          return reread('work.show', { workId })
        }
        const slept = await Promise.race([new Promise<'slept'>((done) => setTimeout(() => done('slept'), POLL_MS)), interrupted])
        if (slept === 'interrupted') return detach()
      }
    } finally {
      process.off('SIGINT', onInterrupt)
    }
  }

  const work: WorkCommands = {
    admitFile(path, input, goal, worker) {
      const workflow = readFileSync(path, 'utf8')
      return change('work.submit', { workflow, uses: usedFiles(workflow, dirname(path)), input, goal, worker })
    },
    admitTask: (capabilities, input, goal, worker) => change('work.submit', { capabilities, input, goal, worker }),
    async run(workId, options) {
      await change('work.run', { workId })
      return follow(workId, options)
    },
    get: (workId) => read('work.show', { workId }) as Promise<WorkRecord>,
    list: () => read('work.list'),
    report: (workId) => read('work.report', { workId }),
    async newGoal(goal, supersedes, operator) {
      // Like a decision, a Goal is a human's: its own connection says so.
      const human = await remote.open({ type: 'human', operatorId: operator })
      try {
        return await human.call('goal.new', { ...goal, supersedes }) as { id: string }
      } finally {
        human.close()
      }
    },
    goal: (goalId) => read('goal.show', { goal: goalId }) as Promise<GoalView>,
    brief: async (goalId) => (await read('goal.brief', { goal: goalId }) as { text: string }).text,
    addDecision: (decision) => read('decision.add', decision),
    decisions: (goalId) => read('decision.list', goalId ? { goal: goalId } : {}),
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

  return {
    work: () => work,
    artifacts: () => ({
      async putFile(path: string, mediaType: string, classification: string): Promise<Envelope> {
        if (!(CLASSIFICATIONS as readonly string[]).includes(classification)) throw new Error(`unknown classification ${classification}`)
        const data = base64(readFileSync(path))
        if (!fitsFrame(data)) throw new Error(`${path} is too large to send to the Host (${data.length} bytes in base64; a frame holds ${MAX_FRAME})`)
        return read('artifact.put', { data, mediaType, classification })
      },
      async get(id: string): Promise<ReadResult> {
        if (!CONTENT_ID_RE.test(id)) throw new Error(`not an Artifact ID: ${id}`)
        return read('artifact.show', { id })
      },
      async readBytes(id: string) {
        if (!CONTENT_ID_RE.test(id)) throw new Error(`not an Artifact ID: ${id}`)
        return Buffer.from((await read('artifact.cat', { id })).data, 'base64')
      },
    }),
    credentials: () => ({
      set: async (name, value) => { await read('credentials.set', { name, value }) },
      describe: async (name) => (await read('credentials.status', { names: [name] }))[0],
    }),
    workers: () => read('workers.list'),
    // A manual sign-in waits for the operator, so this call outlasts the usual answer time.
    loginRemote: async (ref, show) => {
      show(await read('workers.loginRemote', { ref }))
      const client = await link()
      // Ctrl-C ends the session in the Host; the wait below then returns its report.
      const onInterrupt = () => { void client.call('workers.loginWait', { ref, cancel: true }).catch(() => {}) }
      process.once('SIGINT', onInterrupt)
      try {
        return await client.call('workers.loginWait', { ref }, REMOTE_LOGIN_TIMEOUT) as any
      } finally {
        process.off('SIGINT', onInterrupt)
      }
    },
    recheck: async (ref) => (await link()).call('workers.recheck', { ref }, RECHECK_TIMEOUT) as any,
    login: async (ref, cookies) => (await link()).call('workers.login', { ref, ...(cookies === undefined ? {} : { cookies }) }, LOGIN_TIMEOUT) as any,
  }
}
