/**
 * The Host's operation table (PROP-0004 C4, C8): one row per operation,
 * `method -> { params, handler, agent }`. A row is the only place an
 * operation's name, shape and authority are written; the README's API
 * reference is generated from it. What a row needs from outside the Host core
 * (Artifacts, credentials, Workers) comes in as `Services`.
 */
import { createHash } from 'node:crypto'
import { CLASSIFICATIONS, ITEM_ID, WorkError, WorkflowError, contentIdSchema as artifactId, directTask, itemLines, parseWorkflow, readStatus, resolve, summarize, workStatus, z, type Admission, type Capabilities, type Caller, type Host, type WorkRecord } from '@system/work'
import { MAX_FRAME, NOT_ALLOWED, RpcError, fitsFrame, type Link, type Method, type Methods } from './index.ts'

/** What the operations need besides the Host: the DSH-backed parts, which tests replace. */
export interface Services {
  capabilities: Capabilities
  /** Store bytes as a `file@1` Artifact. */
  putFile(data: Uint8Array, mediaType: string, classification: string, caller: Caller): Promise<{ id: string }>
  /** An Artifact's envelope and occurrences, or its state when it is not stored. */
  artifact(id: string): unknown
  readBytes(id: string): Promise<Uint8Array>
  newTask(instructions: string, repository: string | undefined, ref: string | undefined, context: string[], caller: Caller, item?: string, against?: string): Promise<{ task: string; base?: string }>
  /** A Workflow file a Workflow uses: `workflows/<name>` at the base commit of the `input` Task, else beside the Host's own code; undefined when neither has it. */
  workflowFile(name: string, input: string | undefined): string | undefined
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
  /** Check a browser Account without sending anything; it is `ready` again only when the check passes. */
  recheck(ref: string): Promise<{ ready: boolean; state: string; detail: string }>
}

const commandId = z.string().min(1).optional()
const workId = z.string().min(1)
/** Bytes as base64: canonical, so what was sent is what is stored. */
const base64 = z.string().max(MAX_FRAME).refine((text) => Buffer.from(text, 'base64').toString('base64') === text, 'not canonical base64')

/** A used Workflow file: the one the caller sent, else the one the Host finds (PROP-0007 decision 7). */
const usedFile = (files: Record<string, string>, found: (name: string) => string | undefined) => (name: string): string => {
  const text = Object.hasOwn(files, name) ? files[name] : found(name)
  if (text === undefined) throw new WorkflowError([`no Workflow file ${name}: not sent with the Workflow (uses), not in workflows/ of the input's base commit, nor of the Host`])
  return text
}

const known = (host: Host, id: string): WorkRecord => {
  const record = host.view.get(id)
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

const watching = z.object({ workId }).strict()

/** Add to or remove from what the connection watches; the reply is where the Work stands now. */
function watch(host: Host, p: z.infer<typeof watching>, link: Link, on: boolean): { status: string; seq: number } {
  const record = known(host, p.workId)
  link.works[on ? 'add' : 'delete'](p.workId)
  if (on) link.listen()
  return { status: record.state.status, seq: record.events.at(-1)!.seq }
}

export function operations(services: Services): Methods {
  return {
    'work.submit': {
      agent: true,
      summary: 'Admit a Work and run it (unless `run` is false), from the contents of a Workflow file, or a single Task by capability, and return its record; with `run` false it only admits, and `work.run` starts it later. `uses` may hold the contents of the Workflow files it uses (Sub-workflows), by file name; a file not sent is read from `workflows/` at the input Task\'s base commit, else beside the Host\'s code. They are joined into the pinned spec now. With `worker`, only that Worker may take the Worker steps of the Work; it is refused when that Worker is not registered or lacks the capabilities of a step. When the input Task names an Item that already has a running or held Work, it is refused, naming that Work and its Account, unless `force` is true.',
      params: z.object({ workflow: z.string().min(1).optional(), uses: z.record(z.string(), z.string()).default({}), capabilities: z.array(z.string().min(1)).min(1).optional(), input: artifactId.optional(), worker: z.string().min(1).optional(), force: z.boolean().optional(), run: z.boolean().default(true), commandId }).strict()
        .refine((p) => Boolean(p.workflow) !== Boolean(p.capabilities), 'give exactly one of workflow and capabilities'),
      handler(host, p, caller) {
        const available = services.capabilities.available()
        const admission: Admission = p.workflow
          ? { spec: resolve(parseWorkflow(p.workflow), available, usedFile(p.uses, (name) => services.workflowFile(name, p.input))), input: p.input, worker: p.worker, force: p.force, caller, source: { kind: 'workflow-file', fileHash: `sha256:${createHash('sha256').update(p.workflow).digest('hex')}` } }
          : { spec: directTask(p.capabilities, p.input !== undefined, available), input: p.input, worker: p.worker, force: p.force, caller, source: { kind: 'direct-task' } }
        return host.submit(admission, { commandId: p.commandId }).then((work) => (p.run ? started(host, work.id, (go) => host.run(work.id, { commandId: p.commandId && `${p.commandId}:run`, started: go })) : work))
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
      summary: 'Run a step of failed, cancelled or held Work again as a new attempt, and return its record once it is running; the steps after it are reset. A verify step is asked again on the same subject with the same pinned criteria, by a human caller only; its earlier verdict stays recorded and no longer counts.',
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
      read: true,
      agent: true,
      summary: 'The Work record: events and state; while Worker attempts run, also `live`: per attempt its step, Worker, start, last activity, elapsed and quiet seconds, whether it is stalled, and the `progress` its Runtime last reported (turns, last tool, tokens, stage). `live` is an observation of the moment, never part of the record.',
      params: z.object({ workId }).strict(),
      handler(host, p) {
        const record = known(host, p.workId)
        const live = host.view.live(p.workId)
        return live.length ? { ...record, live } : record
      },
    },
    'work.list': {
      read: true,
      agent: true,
      summary: 'Every Work as `{ id, status, specId }`; `status` is `admitted, not running` for a Work admitted and never run.',
      params: z.object({}).strict(),
      handler: (host) => host.view.list().map((r) => ({ id: r.id, status: workStatus(r), specId: r.state.specId })),
    },
    'work.replay': {
      read: true,
      agent: true,
      summary: 'Fold the recorded events again: `{ state, matches }`. Runs nothing.',
      params: z.object({ workId }).strict(),
      handler: (host, p) => (known(host, p.workId), host.view.replay(p.workId)),
    },
    'work.report': {
      read: true,
      agent: true,
      summary: 'Duration, attempts, time waited for a slot, rate-limited attempts, operator touches and usage of a Work, from its events.',
      params: z.object({ workId }).strict(),
      handler: (host, p) => summarize(known(host, p.workId)),
    },
    'work.events': {
      read: true,
      agent: true,
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
      summary: 'Keep this connection subscribed: the Host sends the notification `work.changed { workId, status, seq }` (no `id`) when the Work becomes terminal, is held, or starts awaiting approval, and `work.changed { workId, status, seq, stalled: true }` when one of its attempts has been quiet for `stallMinutes`. A notice only wakes the client: read `work.events` from your cursor. Replies `{ status, seq }` of the Work now.',
      params: watching,
      handler: (host, p, _caller, link) => watch(host, p, link, true),
    },
    'work.unwatch': {
      read: true,
      agent: true,
      summary: 'Stop the notices of `work.watch` for a Work on this connection.',
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
    'task.new': {
      agent: true,
      summary: 'Store a `task@1` Artifact (and, with `repository`, the exact base commit): `{ task, base? }`. With `against`, the base is a change from that commit of `repository`, so a verifier selects checks by the files that differ between the two. With `item`, the Task names that Item of the repository\'s STATUS.md (see `status`); it is refused when the repository\'s `dev` has no line for the Item.',
      params: z.object({ instructions: z.string().min(1), repository: z.string().min(1).optional(), ref: z.string().min(1).optional(), context: z.array(artifactId).default([]), item: z.string().regex(ITEM_ID).optional(), against: z.string().min(1).optional() }).strict(),
      handler: (_host, p, caller) => services.newTask(p.instructions, p.repository, p.repository ? p.ref ?? 'HEAD' : undefined, p.context, caller, p.item, p.repository ? p.against : undefined),
    },
    status: {
      read: true,
      agent: true,
      summary: 'The status of a project: one line per Item of the repository\'s `STATUS.md` on its `origin/dev` tip (else `dev`), as `[x] <id> <title> - <state>`. `done`: a Work for the Item was merged into `dev` (read from the Host\'s store), or `[x]` in `STATUS.md` for work done outside System (with the last merged Work and Artifact IDs when known); `doing`: a Work whose Task names the Item is running or held (its ID, step, Account, since when, and its live progress, or why it is held); `todo`: nobody. `state` and `item` narrow it; STATUS.md lines that could not be read follow as `note:` lines, after one that names the ref read and how old it is. Read the Work by ID for details.',
      params: z.object({ repository: z.string().min(1), state: z.enum(['todo', 'doing', 'done']).optional(), item: z.string().regex(ITEM_ID).optional() }).strict(),
      async handler(host, p) {
        const status = await readStatus(p.repository)
        return [...itemLines(status, status.repository, host.view.list(), (workId) => host.view.live(workId), { state: p.state, item: p.item }, host.view.claims()), ...[status.note, ...status.problems].map((problem) => `note: ${problem}`)]
      },
    },
    'item.claim': {
      agent: true,
      summary: 'Claim an Item of the repository\'s STATUS.md before submitting a Work for it: `{ repository, item, who, at }`, with `who` the caller\'s operator ID. `status` then shows the Item as `doing`, claimed by `who` since `at`; a Work submitted for the Item takes the claim over. Refused when the Item has no line in STATUS.md, has a running or held Work, or is claimed by another caller, unless `force` is true.',
      params: z.object({ repository: z.string().min(1), item: z.string().regex(ITEM_ID), force: z.boolean().optional() }).strict(),
      async handler(host, p, caller) {
        const status = await readStatus(p.repository)
        if (!status.items.some((i) => i.id === p.item)) throw new WorkError(`Item ${p.item} has no line in STATUS.md on ${status.ref} of ${status.repository}`)
        return host.claim(status.repository, p.item, caller, p.force)
      },
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
      summary: 'An Artifact\'s envelope and occurrences, or why it is not stored.',
      params: z.object({ id: artifactId }).strict(),
      handler: (_host, p) => services.artifact(p.id),
    },
    'artifact.cat': {
      read: true,
      agent: true,
      summary: 'The bytes of a blob Artifact as `{ data }` in base64; refused when they do not fit a frame.',
      params: z.object({ id: artifactId }).strict(),
      async handler(_host, p) {
        const data = Buffer.from(await services.readBytes(p.id)).toString('base64')
        if (!fitsFrame(data)) throw new WorkError(`${p.id} is too large for one reply (${data.length} bytes in base64)`)
        return { data }
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
      summary: 'Sign a browser Account (`web/<site>/<name>`) in: import the contents of a cookie file, or without one open a visible window where the Host has a display. Returns whether it is signed in; no cookie value is returned.',
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
    'workers.recheck': {
      agent: false,
      summary: 'Recheck a browser Account that is quarantined or cooling down: its profile opens headed on a private display and the sign-in, Chat mode and temporary chat are checked; nothing is sent. Returns `{ ready, state, detail }`; the Account is `ready` again only when the check passes, and this is the only way out of `needs-sign-in` and `challenged`.',
      params: z.object({ ref: z.string().min(1) }).strict(),
      handler: (_host, p) => services.recheck(p.ref),
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
