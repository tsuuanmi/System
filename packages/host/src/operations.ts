/**
 * The Host's operation table (PROP-0004 C4, C8): one row per operation,
 * `method -> { params, handler, agent }`. A row is the only place an
 * operation's name, shape and authority are written; the README's API
 * reference is generated from it. What a row needs from outside the Host core
 * (Artifacts, credentials, Workers) comes in as `Services`.
 */
import { createHash } from 'node:crypto'
import { CLASSIFICATIONS, WorkError, contentIdSchema as artifactId, assertedSchema, goalSchema, directTask, parseWorkflow, previewConversation, resolve, summarize, z, type Admission, type Asserted, type Capabilities, type Caller, type ConversationParts, type Goal, type Host, type WorkRecord } from '@system/work'
import { MAX_FRAME, NOT_ALLOWED, RpcError, fitsFrame, type Methods } from './index.ts'

/** What the operations need besides the Host: the DSH-backed parts, which tests replace. */
export interface Services {
  capabilities: Capabilities
  /** Store bytes as a `file@1` Artifact. */
  putFile(data: Uint8Array, mediaType: string, classification: string, caller: Caller): Promise<{ id: string }>
  /** An Artifact's envelope and occurrences, or its state when it is not stored. */
  artifact(id: string): unknown
  readBytes(id: string): Promise<Uint8Array>
  newTask(instructions: string, repository: string | undefined, ref: string | undefined, context: string[], caller: Caller): Promise<{ task: string; base?: string }>
  /** Store a `goal@1`; without `context`, the Charter is stored and used. `supersedes` is the Goal it raises or changes. */
  newGoal(goal: Omit<Goal, 'context'> & { context?: string[] }, supersedes: string | undefined, caller: Caller): Promise<{ id: string }>
  addConversation(parts: ConversationParts, asserted: Asserted, supersedes: string[], caller: Caller): Promise<{ id: string }>
  credentials: {
    set(name: string, value: string): Promise<void>
    describe(name: string): Promise<{ configured: boolean; source?: string }>
  }
  workers(): Promise<{ registered: string[]; accounts: unknown[] }>
  /** Sign a browser Account in, by the cookie file's contents or by hand where a display exists, and report whether it is signed in. */
  login(ref: string, cookies: string | undefined): Promise<{ signedIn: boolean; detail: string; imported?: number; skipped?: number }>
}

const commandId = z.string().min(1).optional()
const workId = z.string().min(1)
/** Bytes as base64: canonical, so what was sent is what is stored. */
const base64 = z.string().max(MAX_FRAME).refine((text) => Buffer.from(text, 'base64').toString('base64') === text, 'not canonical base64')
const part = z.object({ name: z.string().min(1), data: base64, mediaType: z.string().min(1) }).strict()
const parts = z.object({ response: part, prompt: part.optional(), attachments: z.array(part).default([]) }).strict()

const bytesOf = (p: z.infer<typeof part>) => ({ name: p.name, data: Buffer.from(p.data, 'base64'), mediaType: p.mediaType })
const conversationOf = (p: z.infer<typeof parts>): ConversationParts => ({
  response: bytesOf(p.response), ...(p.prompt ? { prompt: bytesOf(p.prompt) } : {}), attachments: p.attachments.map(bytesOf),
})

const known = (host: Host, id: string): WorkRecord => {
  const record = host.get(id)
  if (!record) throw new WorkError(`no Work ${id}`)
  return record
}

/**
 * Start `begin`, then answer as soon as it says its Work is being driven: the
 * run goes on without the caller. A refusal before that point (no such Work,
 * already running) is the answer. A failure after it is the Work's to show.
 */
async function started(host: Host, id: string, begin: (started: () => void) => Promise<unknown>): Promise<WorkRecord> {
  let go!: () => void
  const ready = new Promise<void>((resolve) => { go = resolve })
  const done = begin(go)
  done.catch(() => {})
  await Promise.race([ready, done])
  return known(host, id)
}

export function operations(services: Services): Methods {
  return {
    'work.submit': {
      agent: true,
      summary: 'Admit a Work from the contents of a Workflow file, or a single Task by capability, and return its record. It does not run it. With `goal`, it counts toward that Goal and is refused once the budget of the Goal is spent.',
      params: z.object({ workflow: z.string().min(1).optional(), capabilities: z.array(z.string().min(1)).min(1).optional(), input: artifactId.optional(), goal: artifactId.optional(), commandId }).strict()
        .refine((p) => Boolean(p.workflow) !== Boolean(p.capabilities), 'give exactly one of workflow and capabilities'),
      handler(host, p, caller) {
        const available = services.capabilities.available()
        const admission: Admission = p.workflow
          ? { spec: resolve(parseWorkflow(p.workflow), available), input: p.input, goal: p.goal, caller, source: { kind: 'workflow-file', fileHash: `sha256:${createHash('sha256').update(p.workflow).digest('hex')}` } }
          : { spec: directTask(p.capabilities, p.input !== undefined, available), input: p.input, goal: p.goal, caller, source: { kind: 'direct-task' } }
        return host.submit(admission, { commandId: p.commandId })
      },
    },
    'work.run': {
      agent: true,
      summary: 'Start admitted or interrupted Work and return its record once it is running; follow it with `work.events`.',
      params: z.object({ workId, commandId }).strict(),
      handler: (host, p) => started(host, p.workId, (go) => host.run(p.workId, { commandId: p.commandId, started: go })),
    },
    'work.retry': {
      agent: true,
      summary: 'Run a Worker step of failed, cancelled or held Work again as a new attempt, and return its record once it is running.',
      params: z.object({ workId, step: z.string().min(1).optional(), worker: z.string().min(1).optional(), reason: z.string().default('retried by the operator'), commandId }).strict(),
      handler: (host, p, caller) => started(host, p.workId, (go) => host.retry(p.workId, { step: p.step, worker: p.worker, reason: p.reason, caller, commandId: p.commandId, started: go })),
    },
    'work.cancel': {
      agent: true,
      summary: 'Stop Work: its record once cancelled, or `"requested"` while a run is stopping its attempt.',
      params: z.object({ workId, reason: z.string().default('cancelled by the operator'), commandId }).strict(),
      handler: (host, p, caller) => host.cancel(p.workId, { reason: p.reason, caller, commandId: p.commandId }),
    },
    'work.show': {
      agent: true,
      summary: 'The Work record: events and state.',
      params: z.object({ workId }).strict(),
      handler: (host, p) => known(host, p.workId),
    },
    'work.list': {
      agent: true,
      summary: 'Every Work as `{ id, status, specId }`.',
      params: z.object({}).strict(),
      handler: (host) => host.list().map((r) => ({ id: r.id, status: r.state.status, specId: r.state.specId })),
    },
    'work.replay': {
      agent: true,
      summary: 'Fold the recorded events again: `{ state, matches }`. Runs nothing.',
      params: z.object({ workId }).strict(),
      handler: (host, p) => (known(host, p.workId), host.replay(p.workId)),
    },
    'work.report': {
      agent: true,
      summary: 'Duration, attempts, operator touches and usage of a Work, from its events; for a Work of a Goal also the Goal, its budget and its spend.',
      params: z.object({ workId }).strict(),
      handler(host, p) {
        const record = known(host, p.workId)
        const admitted = record.events[0]
        if (admitted?.type !== 'admitted' || !admitted.goal) return summarize(record)
        const { id, current, spend } = host.goal(admitted.goal)
        return { ...summarize(record), goal: { id, current: current.id, budget: current.goal.budget, spend } }
      },
    },
    'work.events': {
      agent: true,
      summary: 'The events with `seq` above `after` (all when omitted) and the current status: `{ events, status }`. Poll it to follow a Work.',
      params: z.object({ workId, after: z.number().int().min(-1).optional() }).strict(),
      handler(host, p) {
        const record = known(host, p.workId)
        return { events: record.events.filter((e) => e.seq > (p.after ?? -1)), status: record.state.status }
      },
    },
    'approval.decide': {
      agent: false,
      summary: 'Record a human\'s decision on what held Work awaits, and continue it. Only a human caller; the CLI sends it after its terminal confirmation.',
      params: z.object({ workId, decision: z.enum(['approved', 'denied']), reason: z.string().min(1), commandId }).strict(),
      handler(host, p, caller) {
        if (caller.type !== 'human') throw new RpcError(NOT_ALLOWED, 'approval.decide: needs a human caller')
        return started(host, p.workId, (go) => host.decide(p.workId, { decision: p.decision, reason: p.reason, caller, commandId: p.commandId, started: go }))
      },
    },
    'goal.new': {
      agent: false,
      summary: 'Store a `goal@1` the operator wrote: `{ id }`. `supersedes` names the Goal it raises or changes; without `context` the Charter is the context. Only a human caller; the CLI sends it after its terminal confirmation.',
      params: z.object({ aim: goalSchema.shape.aim, scope: goalSchema.shape.scope, budget: goalSchema.shape.budget.default({}), context: goalSchema.shape.context.optional(), supersedes: artifactId.optional() }).strict(),
      handler(_host, { supersedes, ...goal }, caller) {
        if (caller.type !== 'human') throw new RpcError(NOT_ALLOWED, 'goal.new: needs a human caller')
        return services.newGoal(goal, supersedes, caller)
      },
    },
    'goal.show': {
      agent: true,
      summary: 'A Goal, its current version (the newest that supersedes it) and the spend of the chain, folded from the Works admitted for it: `{ id, goal, current, spend }`.',
      params: z.object({ goal: artifactId }).strict(),
      handler: (host, p) => host.goal(p.goal),
    },
    'task.new': {
      agent: true,
      summary: 'Store a `task@1` Artifact (and, with `repository`, the exact base commit): `{ task, base? }`.',
      params: z.object({ instructions: z.string().min(1), repository: z.string().min(1).optional(), ref: z.string().min(1).optional(), context: z.array(artifactId).default([]) }).strict(),
      handler: (_host, p, caller) => services.newTask(p.instructions, p.repository, p.repository ? p.ref ?? 'HEAD' : undefined, p.context, caller),
    },
    'artifact.put': {
      agent: true,
      summary: 'Store bytes (base64, within the frame limit) as a `file@1` Artifact: its envelope.',
      params: z.object({ data: base64, mediaType: z.string().min(1).default('application/octet-stream'), classification: z.enum(CLASSIFICATIONS).default('local-private') }).strict(),
      handler: (_host, p, caller) => services.putFile(Buffer.from(p.data, 'base64'), p.mediaType, p.classification, caller),
    },
    'artifact.show': {
      agent: true,
      summary: 'An Artifact\'s envelope and occurrences, or why it is not stored.',
      params: z.object({ id: artifactId }).strict(),
      handler: (_host, p) => services.artifact(p.id),
    },
    'artifact.cat': {
      agent: true,
      summary: 'The bytes of a blob Artifact as `{ data }` in base64; refused when they do not fit a frame.',
      params: z.object({ id: artifactId }).strict(),
      async handler(_host, p) {
        const data = Buffer.from(await services.readBytes(p.id)).toString('base64')
        if (!fitsFrame(data)) throw new WorkError(`${p.id} is too large for one reply (${data.length} bytes in base64)`)
        return { data }
      },
    },
    'conversation.preview': {
      agent: true,
      summary: 'What would be stored of a conversation, and what looks like a secret in it. Stores nothing.',
      params: z.object({ parts, asserted: assertedSchema.default({}) }).strict(),
      handler: (_host, p) => previewConversation(conversationOf(p.parts), p.asserted),
    },
    'conversation.add': {
      agent: false,
      summary: 'Store a conversation held elsewhere: `{ id }`. Refused when the preview has warnings, unless `acceptWarnings`.',
      params: z.object({ parts, asserted: assertedSchema.default({}), supersedes: z.array(artifactId).default([]), acceptWarnings: z.boolean().default(false) }).strict(),
      handler(_host, p, caller) {
        const conversation = conversationOf(p.parts)
        if (previewConversation(conversation, p.asserted).warnings.length && !p.acceptWarnings) {
          throw new WorkError('the preview has warnings; nothing stored. Remove what it names, or add acceptWarnings to store it anyway')
        }
        return services.addConversation(conversation, p.asserted, p.supersedes, caller)
      },
    },
    'workers.list': {
      agent: true,
      summary: 'The registered Workers, and each configured agent account with why it is or is not available.',
      params: z.object({}).strict(),
      handler: () => services.workers(),
    },
    'workers.login': {
      agent: false,
      summary: 'Sign a browser Account (`chatgpt-web/<name>`) in: import the contents of a cookie file, or without one open a visible window where the Host has a display. Returns whether it is signed in; no cookie value is returned.',
      params: z.object({ ref: z.string().min(1), cookies: z.string().max(MAX_FRAME).optional() }).strict(),
      handler: (_host, p) => services.login(p.ref, p.cookies),
    },
    'credentials.status': {
      agent: false,
      summary: 'Whether each name is configured, and from where: `{ name, configured, source? }` per name. Values never leave the Host.',
      params: z.object({ names: z.array(z.string().min(1)).min(1) }).strict(),
      handler: async (_host, p) => Promise.all(p.names.map(async (name: string) => ({ name, ...await services.credentials.describe(name) }))),
    },
    'credentials.set': {
      agent: false,
      summary: 'Store a value under a name in the DSH credential store. Nothing returns it.',
      params: z.object({ name: z.string().min(1), value: z.string().min(1) }).strict(),
      async handler(_host, p) {
        await services.credentials.set(p.name, p.value)
        return { stored: p.name }
      },
    },
  }
}
