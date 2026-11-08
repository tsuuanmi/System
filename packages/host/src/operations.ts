/**
 * The Host's operation table (PROP-0004 C4, C8): one row per operation,
 * `method -> { params, handler, agent }`. A row is the only place an
 * operation's name, shape and authority are written; the README's API
 * reference is generated from it. What a row needs from outside the Host core
 * (Artifacts, credentials, Workers) comes in as `Services`.
 */
import { createHash } from 'node:crypto'
import { CLASSIFICATIONS, WorkError, WorkflowError, contentIdSchema as artifactId, assertedSchema, decisionSchema, goalSchema, TASK_KIND, directTask, parseWorkflow, previewConversation, resolve, summarize, z, type Admission, type Asserted, type Capabilities, type Caller, type ConversationParts, type Host, type NewDecision, type NewGoal, type StoredDecision, type WorkEvent, type WorkRecord } from '@system/work'
import { brief } from './brief.ts'
import { MAX_FRAME, NOT_ALLOWED, RpcError, fitsFrame, inScope, type Link, type Method, type Methods } from './index.ts'

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
  newGoal(goal: NewGoal, supersedes: string | undefined, caller: Caller): Promise<{ id: string }>
  addConversation(parts: ConversationParts, asserted: Asserted, supersedes: string[], caller: Caller): Promise<{ id: string }>
  /** A Workflow file a Workflow uses: `workflows/<name>` at the base commit of the `input` Task, else beside the Host's own code; undefined when neither has it. */
  workflowFile(name: string, input: string | undefined): string | undefined
  /** Store a `decision@1` by `caller`, after the latest one of its Goal's chain. */
  addDecision(decision: NewDecision, caller: Caller): Promise<{ id: string }>
  /** The decisions of the Goals in `chain` (all without it), oldest first. */
  decisions(chain?: ReadonlySet<string>): StoredDecision[]
  credentials: {
    set(name: string, value: string): Promise<void>
    describe(name: string): Promise<{ configured: boolean; source?: string }>
  }
  workers(): Promise<{ registered: string[]; accounts: unknown[] }>
  /** Sign a browser Account in, by the cookie file's contents or by hand where a display exists, and report whether it is signed in. */
  login(ref: string, cookies: string | undefined): Promise<{ signedIn: boolean; detail: string; imported?: number; skipped?: number }>
  /** Start the remote sign-in of a browser Account: where to reach its viewer, and until when. */
  loginRemote(ref: string): Promise<{ url: string; port: number; ssh: string; expiresAt: number }>
  /** Wait for the remote sign-in of `ref` to end (Save, Cancel, expiry), or end it first with `cancel`; the signed-in state. */
  loginWait(ref: string, cancel: boolean): Promise<{ signedIn: boolean; detail: string }>
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

/** A used Workflow file: the one the caller sent, else the one the Host finds (PROP-0007 decision 7). */
const usedFile = (files: Record<string, string>, found: (name: string) => string | undefined) => (name: string): string => {
  const text = Object.hasOwn(files, name) ? files[name] : found(name)
  if (text === undefined) throw new WorkflowError([`no Workflow file ${name}: not sent with the Workflow (uses), not in workflows/ of the input's base commit, nor of the Host`])
  return text
}

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

type Orchestrator = Caller & { type: 'orchestrator' }

const outside = (what: string, caller: Orchestrator) => new RpcError(NOT_ALLOWED, `${what} is outside the scope of the orchestrator's Goal ${caller.goal}: it reaches only the Works of that Goal and of its supersedes chain`)

/** Every Artifact ID an event names as an input, output or evidence. */
function named(event: WorkEvent): string[] {
  switch (event.type) {
    case 'admitted': return [...(event.input ? [event.input] : []), ...Object.values(event.criteria ?? {})]
    case 'dispatched': return Object.values(event.inputs)
    case 'observed': return [...Object.values(event.outputs), ...Object.values(event.partial ?? {}), ...(event.log ? [event.log] : [])]
    case 'verified': return [event.subject, ...(event.verdictId ? [event.verdictId] : []), ...(event.evidence ?? [])]
    case 'terminal': return Object.values(event.results)
    default: return []
  }
}

/** The Artifacts of the orchestrator's Works: what their events name, and the context and base of each Task among them. */
function scopedArtifacts(host: Host, services: Services, caller: Orchestrator): Set<string> {
  const found = new Set<string>()
  for (const record of host.list()) if (inScope(host, caller.goal, record.id)) for (const event of record.events) for (const id of named(event)) found.add(id)
  for (const id of [...found]) {
    const read = services.artifact(id) as { state?: string; envelope?: { kind?: string; content?: { context?: string[]; base?: string } } }
    if (read.state !== 'stored' || read.envelope?.kind !== TASK_KIND.kind) continue
    for (const more of [...(read.envelope.content?.context ?? []), ...(read.envelope.content?.base ? [read.envelope.content.base] : [])]) found.add(more)
  }
  return found
}

const watching = z.object({ workId: workId.optional(), goal: artifactId.optional() }).strict()
  .refine((p) => Boolean(p.workId) !== Boolean(p.goal), 'give exactly one of workId and goal')

/** An orchestrator watches only the Works of its Goal, and its Goal's chain. */
function watchScope(host: Host, p: z.infer<typeof watching>, caller: Orchestrator, name: string): z.infer<typeof watching> {
  if (p.workId ? !inScope(host, caller.goal, p.workId) : !host.goalChain(caller.goal).has(p.goal!)) throw outside(`${name} on ${p.workId ?? p.goal}`, caller)
  return p
}

/** Add to or remove from what the connection watches; the reply is where the Work stands now. */
function watch(host: Host, p: z.infer<typeof watching>, link: Link, on: boolean): { status: string; seq: number } | { goal: string } {
  if (p.goal) {
    host.goal(p.goal)
    link.goals[on ? 'add' : 'delete'](p.goal)
    if (on) link.listen()
    return { goal: p.goal }
  }
  const record = known(host, p.workId!)
  link.works[on ? 'add' : 'delete'](p.workId!)
  if (on) link.listen()
  return { status: record.state.status, seq: record.events.at(-1)!.seq }
}

export function operations(services: Services): Methods {
  /** The scope of a row on one Work: refused unless the Work is the orchestrator's. */
  const ofWork = (name: string): Method['scope'] => (host, p, caller) => {
    if (!inScope(host, caller.goal, p.workId)) throw outside(`${name} on ${p.workId}`, caller)
    return p
  }
  /** A row that names a Goal: it may only be the orchestrator's own, which is filled in when absent. */
  const ownGoal = (name: string): Method['scope'] => (_host, p, caller) => {
    if (p.goal !== undefined && p.goal !== caller.goal) throw outside(`${name} for Goal ${p.goal}`, caller)
    return { ...p, goal: caller.goal }
  }
  /** A row that reads a Goal: one of the orchestrator's chain, its own when absent. */
  const inChain = (name: string): Method['scope'] => (host, p, caller) => {
    if (p.goal !== undefined && !host.goalChain(caller.goal).has(p.goal)) throw outside(`${name} on ${p.goal}`, caller)
    return { ...p, goal: p.goal ?? caller.goal }
  }
  const ofArtifact = (name: string): Method['scope'] => (host, p, caller) => {
    if (!scopedArtifacts(host, services, caller).has(p.id)) throw outside(`${name} on ${p.id}`, caller)
    return p
  }
  return {
    'work.submit': {
      agent: true,
      summary: 'Admit a Work from the contents of a Workflow file, or a single Task by capability, and return its record. It does not run it. `uses` may hold the contents of the Workflow files it uses (Sub-workflows), by file name; a file not sent is read from `workflows/` at the input Task\'s base commit, else beside the Host\'s code. They are joined into the pinned spec now. With `goal`, it counts toward that Goal and is refused once the budget of the Goal is spent.',
      params: z.object({ workflow: z.string().min(1).optional(), uses: z.record(z.string(), z.string()).default({}), capabilities: z.array(z.string().min(1)).min(1).optional(), input: artifactId.optional(), goal: artifactId.optional(), commandId }).strict()
        .refine((p) => Boolean(p.workflow) !== Boolean(p.capabilities), 'give exactly one of workflow and capabilities'),
      handler(host, p, caller) {
        const available = services.capabilities.available()
        const admission: Admission = p.workflow
          ? { spec: resolve(parseWorkflow(p.workflow), available, usedFile(p.uses, (name) => services.workflowFile(name, p.input))), input: p.input, goal: p.goal, caller, source: { kind: 'workflow-file', fileHash: `sha256:${createHash('sha256').update(p.workflow).digest('hex')}` } }
          : { spec: directTask(p.capabilities, p.input !== undefined, available), input: p.input, goal: p.goal, caller, source: { kind: 'direct-task' } }
        return host.submit(admission, { commandId: p.commandId })
      },
      scope: ownGoal('work.submit'),
    },
    'work.run': {
      agent: true,
      scope: ofWork('work.run'),
      summary: 'Start admitted or interrupted Work and return its record once it is running; follow it with `work.events`.',
      params: z.object({ workId, commandId }).strict(),
      handler: (host, p) => started(host, p.workId, (go) => host.run(p.workId, { commandId: p.commandId, started: go })),
    },
    'work.retry': {
      agent: true,
      scope: ofWork('work.retry'),
      summary: 'Run a step of failed, cancelled or held Work again as a new attempt, and return its record once it is running; the steps after it are reset. A verify step is asked again on the same subject with the same pinned criteria, by a human caller only; its earlier verdict stays recorded and no longer counts.',
      params: z.object({ workId, step: z.string().min(1).optional(), worker: z.string().min(1).optional(), reason: z.string().default('retried by the operator'), commandId }).strict(),
      handler: (host, p, caller) => started(host, p.workId, (go) => host.retry(p.workId, { step: p.step, worker: p.worker, reason: p.reason, caller, commandId: p.commandId, started: go })),
    },
    'work.cancel': {
      agent: true,
      scope: ofWork('work.cancel'),
      summary: 'Stop Work: its record once cancelled, or `"requested"` while a run is stopping its attempt.',
      params: z.object({ workId, reason: z.string().default('cancelled by the operator'), commandId }).strict(),
      handler: (host, p, caller) => host.cancel(p.workId, { reason: p.reason, caller, commandId: p.commandId }),
    },
    'work.show': {
      read: true,
      agent: true,
      scope: ofWork('work.show'),
      summary: 'The Work record: events and state; while Worker attempts run, also `live`: per attempt its step, Worker, start, last activity, elapsed and quiet seconds, whether it is stalled, and the `progress` its Runtime last reported (turns, last tool, tokens, stage). `live` is an observation of the moment, never part of the record.',
      params: z.object({ workId }).strict(),
      handler(host, p) {
        const record = known(host, p.workId)
        const live = host.live(p.workId)
        return live.length ? { ...record, live } : record
      },
    },
    'work.list': {
      read: true,
      agent: true,
      summary: 'Every Work as `{ id, status, specId }`.',
      params: z.object({}).strict(),
      handler: (host, _p, caller) => host.list().filter((r) => caller.type !== 'orchestrator' || inScope(host, caller.goal, r.id)).map((r) => ({ id: r.id, status: r.state.status, specId: r.state.specId })),
    },
    'work.replay': {
      read: true,
      agent: true,
      scope: ofWork('work.replay'),
      summary: 'Fold the recorded events again: `{ state, matches }`. Runs nothing.',
      params: z.object({ workId }).strict(),
      handler: (host, p) => (known(host, p.workId), host.replay(p.workId)),
    },
    'work.report': {
      read: true,
      agent: true,
      scope: ofWork('work.report'),
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
      read: true,
      agent: true,
      scope: ofWork('work.events'),
      summary: 'The events with `seq` above `after` (all when omitted) and the current status: `{ events, status }`. Poll it to follow a Work.',
      params: z.object({ workId, after: z.number().int().min(-1).optional() }).strict(),
      handler(host, p) {
        const record = known(host, p.workId)
        return { events: record.events.filter((e) => e.seq > (p.after ?? -1)), status: record.state.status }
      },
    },
    'work.watch': {
      read: true,
      agent: true,
      scope: (host, p, caller) => watchScope(host, p, caller, 'work.watch'),
      summary: 'Keep this connection subscribed: the Host sends the notification `work.changed { workId, status, seq }` (no `id`) when the Work becomes terminal, is held, or starts awaiting approval, and `work.changed { workId, status, seq, stalled: true }` when one of its attempts has been quiet for `stallMinutes`. With `goal`, instead one for each new Work of the Goal, with `seq` 0, and the stall notices of its Works. A notice only wakes the client: read `work.events` from your cursor. Replies `{ status, seq }` of the Work now, or `{ goal }`.',
      params: watching,
      handler: (host, p, _caller, link) => watch(host, p, link, true),
    },
    'work.unwatch': {
      read: true,
      agent: true,
      scope: (host, p, caller) => watchScope(host, p, caller, 'work.unwatch'),
      summary: 'Stop the notices of `work.watch` for a Work or a Goal on this connection.',
      params: watching,
      handler: (host, p, _caller, link) => watch(host, p, link, false),
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
      read: true,
      agent: true,
      summary: 'A Goal, its current version (the newest that supersedes it) and the spend of the chain, folded from the Works admitted for it: `{ id, goal, current, spend }`.',
      params: z.object({ goal: artifactId }).strict(),
      scope: inChain('goal.show'),
      handler: (host, p) => host.goal(p.goal),
    },
    'decision.add': {
      agent: true,
      summary: 'Record a choice made for a Goal as a `decision@1` Artifact: the question, the options, the choice, the reason and the Artifacts it rests on (`restsOn`), after the latest decision of the Goal\'s chain: `{ id }`. A record, never an authority. An orchestrator records only for its own Goal.',
      params: z.object({
        goal: artifactId.optional(), question: decisionSchema.shape.question, options: decisionSchema.shape.options,
        choice: decisionSchema.shape.choice, reason: decisionSchema.shape.reason, restsOn: decisionSchema.shape.restsOn.default([]),
      }).strict(),
      scope: ownGoal('decision.add'),
      handler(_host, { goal, ...decision }, caller) {
        if (!goal) throw new WorkError('decision.add needs the Goal it is made for')
        return services.addDecision({ goal, ...decision }, caller)
      },
    },
    'decision.list': {
      read: true,
      agent: true,
      summary: 'The decisions of a Goal and its chain (of every Goal without `goal`), oldest first: `[{ id, at, goal, question, options, choice, reason, restsOn, by, previous? }]`. An orchestrator lists its own Goal\'s.',
      params: z.object({ goal: artifactId.optional() }).strict(),
      scope: inChain('decision.list'),
      handler: (host, p) => services.decisions(p.goal ? host.goalChain(p.goal) : undefined),
    },
    'goal.brief': {
      read: true,
      agent: true,
      summary: 'What a new Orchestrator session starts from, as text written from records only (no model call): the Goal and its budget left, its Works with status, current step and live progress, its decisions, and what waits (approvals, held, failed, stalled Works): `{ text }`. The same records give the same text.',
      params: z.object({ goal: artifactId }).strict(),
      scope: inChain('goal.brief'),
      handler(host, p) {
        const works = host.list().filter((r) => inScope(host, p.goal, r.id))
        return { text: brief(host.goal(p.goal), works, services.decisions(host.goalChain(p.goal)), (id) => host.live(id)) }
      },
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
      read: true,
      agent: true,
      scope: ofArtifact('artifact.show'),
      summary: 'An Artifact\'s envelope and occurrences, or why it is not stored.',
      params: z.object({ id: artifactId }).strict(),
      handler: (_host, p) => services.artifact(p.id),
    },
    'artifact.cat': {
      read: true,
      agent: true,
      scope: ofArtifact('artifact.cat'),
      summary: 'The bytes of a blob Artifact as `{ data }` in base64; refused when they do not fit a frame.',
      params: z.object({ id: artifactId }).strict(),
      async handler(_host, p) {
        const data = Buffer.from(await services.readBytes(p.id)).toString('base64')
        if (!fitsFrame(data)) throw new WorkError(`${p.id} is too large for one reply (${data.length} bytes in base64)`)
        return { data }
      },
    },
    'conversation.preview': {
      read: true,
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
      read: true,
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
    'workers.loginRemote': {
      agent: false,
      summary: 'Start a remote sign-in of a browser Account: its profile opens headed on a private display and a viewer is served on 127.0.0.1 behind a random token. Returns `{ url, port, ssh, expiresAt }`; the operator tunnels to the port over SSH. Follow with `workers.loginWait`.',
      params: z.object({ ref: z.string().min(1) }).strict(),
      handler: (_host, p) => services.loginRemote(p.ref),
    },
    'workers.loginWait': {
      agent: false,
      summary: 'Wait until the remote sign-in of an Account ends (Save, Cancel in the viewer, or its 15 minutes), or with `cancel` end it now. Returns whether the profile is signed in.',
      params: z.object({ ref: z.string().min(1), cancel: z.boolean().optional() }).strict(),
      handler: (_host, p) => services.loginWait(p.ref, p.cancel === true),
    },
    'credentials.status': {
      read: true,
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
