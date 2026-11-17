/**
 * The Host's operation table (PROP-0004 C4, C8): one row per operation,
 * `method -> { params, handler, agent }`. A row is the only place an
 * operation's name, shape and authority are written; the README's API
 * reference is generated from it. What a row needs from outside the Host core
 * (Artifacts, credentials, Workers) comes in as `Services`.
 */
import { createHash } from 'node:crypto'
import { CLASSIFICATIONS, ITEM_ID, WorkError, WorkflowError, contentIdSchema as artifactId, directTask, blockedText, itemBlockedBy, itemLines, mergeCommitOf, parseWorkflow, rangeReport, readStatus, releasesOf, resolve, summarize, workStatus, z, type Admission, type Capabilities, type Caller, type FailureClassifier, type Host, type WorkRecord } from '@system/work'
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
  /** Store an `intent@1` Artifact. */
  newIntent(intent: { title: string; body: string; supersedes?: string; settledBy?: 'operator' }, caller: Caller): Promise<{ intent: string }>
  /** Store a `confirmation@1` Artifact. */
  newConfirmation(confirmation: { subject: string; note: string; date?: string }, caller: Caller): Promise<{ confirmation: string }>
  /** The stored Intents (when, by whom settled) and confirmations, for the operator acts of `work.report`. */
  operatorActs(): { intents: { at: string; settledBy?: 'operator' }[]; confirmations: { date: string }[] }
  /** Store an `escaped-defect@1` Artifact. */
  newDefect(defect: { subject: string; foundBy: string; reason: string; date?: string }, caller: Caller): Promise<{ defect: string }>
  /** The recorded Escaped defects (`escaped-defect@1` content), for `work.report`. */
  defects(): { item?: string; commit?: string; foundBy: string; reason: string; date: string }[]
  /** A Workflow file a Workflow uses: `workflows/<name>` at the base commit of the `input` Task, else beside the Host's own code; undefined when neither has it. */
  workflowFile(name: string, input: string | undefined): string | undefined
  credentials: {
    set(name: string, value: string): Promise<void>
    describe(name: string): Promise<{ configured: boolean; source?: string }>
  }
  workers(): Promise<{ registered: string[]; accounts: unknown[] }>
  /** The optional Classifier row (cls-1), report-only: undefined when the row is off. */
  classifier?: FailureClassifier
  /** Sign a browser Account in, by the cookie file's contents or by hand where a display exists, and report whether it is signed in. */
  login(ref: string, cookies: string | undefined): Promise<{ signedIn: boolean; detail: string; imported?: number; skipped?: number }>
  /** Start the remote sign-in of a browser Account: where to reach its viewer, and until when. */
  loginRemote(ref: string): Promise<{ url: string; port: number; ssh: string; expiresAt: number }>
  /** Wait for the remote sign-in of `ref` to end (Save, Cancel, expiry), or end it first with `cancel`; the signed-in state. */
  loginWait(ref: string, cancel: boolean): Promise<{ signedIn: boolean; detail: string }>
  /** Check a browser Account without sending anything; it is `ready` again only when the check passes. */
  recheck(ref: string): Promise<{ ready: boolean; state: string; detail: string }>
  /** Whether `commit` is in the running release of `repository`: false when it is not, undefined when unknown. */
  releaseHolds?(repository: string, commit: string): Promise<boolean | undefined>
}

/** How long `work.report` with `classify` waits for the Classifier: under the call timeout. */
const CLASSIFY_WAIT_MS = 7000

const commandId = z.string().min(1).optional()
const workId = z.string().min(1)
const date = z.string().refine((d) => !Number.isNaN(Date.parse(d)), 'not a date')
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
      summary: 'Admit a Work and run it (unless `run` is false), from the contents of a Workflow file (through MCP, `system mcp`, `workflow` may instead be the path of a Workflow .yaml file on this machine, `~` expanded, and the Sub-workflows beside it are read too; the Host\'s own call takes contents only), or a single Task by capability, and return its record; with `run` false it only admits, and `work.run` starts it later. `uses` may hold the contents of the Workflow files it uses (Sub-workflows), by file name; a file not sent is read from `workflows/` at the input Task\'s base commit, else beside the Host\'s code. They are joined into the pinned spec now. With `worker`, only that Worker may take the Worker steps of the Work; it is refused when that Worker is not registered or lacks the capabilities of a step. When the input Task names an Item that already has a running or held Work, or is Blocked (it comes after Items not done: `blocked by ...`), it is refused, naming the Work and its Account or what blocks it, unless `force` is true.',
      params: z.object({ workflow: z.string().min(1).optional(), uses: z.record(z.string(), z.string()).default({}), capabilities: z.array(z.string().min(1)).min(1).optional(), input: artifactId.optional(), worker: z.string().min(1).optional(), force: z.boolean().optional(), run: z.boolean().default(true), commandId }).strict()
        .refine((p) => Boolean(p.workflow) !== Boolean(p.capabilities), 'give exactly one of workflow and capabilities'),
      handler(host, p, caller) {
        const available = services.capabilities.available()
        const parsed = (text: string) => {
          try {
            return parseWorkflow(text)
          } catch (error) {
            if (error instanceof WorkflowError && error.message.includes('expected object, received')) throw new Error('workflow is neither the path of a readable .yaml file nor the contents of a Workflow file')
            throw error
          }
        }
        const admission: Admission = p.workflow
          ? { spec: resolve(parsed(p.workflow), available, usedFile(p.uses, (name) => services.workflowFile(name, p.input))), input: p.input, worker: p.worker, force: p.force, caller, source: { kind: 'workflow-file', fileHash: `sha256:${createHash('sha256').update(p.workflow).digest('hex')}` } }
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
      summary: 'Every Work as `{ id, status, specId, item? }`; `status` is `admitted, not running` for a Work admitted and never run; `item` is the Item (ID) its Task names, absent for a Work whose Task names none. With `since` (a date or timestamp, inclusive): only the Works admitted at or after it.',
      params: z.object({ since: date.optional() }).strict(),
      handler(host, p) {
        const from = p.since === undefined ? undefined : Date.parse(p.since)
        return host.view.list()
          .filter((r) => from === undefined || Date.parse(r.events[0]!.at) >= from)
          .map((r) => {
            const first = r.events[0]!
            const item = first.type === 'admitted' ? first.item?.id : undefined
            return { id: r.id, status: workStatus(r), specId: r.state.specId, ...(item ? { item } : {}) }
          })
      },
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
      summary: 'With `workId`: duration, attempts, time waited for a slot, rate-limited attempts, operator touches and usage of a Work, from its events; with the classifier row on, an `unknown` failure that has a Classification shows it as `classified`, and `classify` first asks for those it lacks (`classifying` is true while that goes on). With `since` (a date or timestamp; `until` excludes, `escaped` replaces the recorded Escaped defects with a count the report labels as an override): the headline measure (Items merged per operator act, `headline`: Intents the operator settled, confirmations, releases (merges of `dev` into `main`) and human touches) and the five measures of effect over every Work admitted in the range, each with its counts; Escaped defects are the recorded `escaped-defect@1` Artifacts (`defect.add`) whose Item was merged in the range: Verified Success Rate, Recurring Failure Rate, Escaped Defect Rate, Cost per Verified Work, Time to Verified Resolution, and the attempts\' tool-seconds per second (`toolSecondsPerSecond`; not a share: parallel tool calls overlap, so it can pass 1).',
      params: z.object({ workId: workId.optional(), since: date.optional(), until: date.optional(), escaped: z.number().int().min(0).optional(), classify: z.boolean().optional() }).strict(),
      async handler(host, p) {
        if ((p.workId === undefined) === (p.since === undefined)) throw new Error('give `workId`, or `since` for a range')
        const classifier = services.classifier
        if (p.classify && p.workId === undefined) throw new Error('`classify` goes with `workId`')
        if (p.classify && !classifier) throw new Error('the classifier row is disabled (a profile patch turns it on with `disabled: false`)')
        if (p.workId !== undefined) {
          if (p.until !== undefined || p.escaped !== undefined) throw new Error('`until` and `escaped` go with `since`')
          const record = known(host, p.workId)
          // Asking is the operator's choice; a report otherwise only reads what is recorded. A call is bounded (CALL_TIMEOUT):
          // classification that is still going on goes on in the Host, and the report says so (`classifying`); ask again for the rest.
          let classifying = false
          if (p.classify) {
            let timer: NodeJS.Timeout | undefined
            const finished = await Promise.race([classifier!.classify(record).then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), CLASSIFY_WAIT_MS) })])
            clearTimeout(timer)
            classifying = !finished
          }
          return { ...summarize(record, classifier?.lookup), ...(classifying ? { classifying: true } : {}) }
        }
        const records = host.view.list()
        // Releases are merges of `dev` into `main` seen in each repository the Host knows Items for.
        const repositories = new Set(records.flatMap((r) => { const first = r.events[0]!; return first.type === 'admitted' && first.item?.repository ? [first.item.repository] : [] }))
        const releases = (await Promise.all([...repositories].map((repository) => releasesOf(repository)))).flat()
        return rangeReport(records, { ...services.operatorActs(), releases, since: p.since!, ...(p.until === undefined ? {} : { until: p.until }), ...(p.escaped === undefined ? {} : { escaped: p.escaped }), defects: services.defects(), ...(classifier ? { classified: classifier.lookup } : {}) })
      },
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
      summary: 'Store a `task@1` Artifact (and, with `repository`, the exact base commit): `{ task, base? }`. With `against`, the base is a change from that commit of `repository`, so a verifier selects checks by the files that differ between the two. With `item`, the Task names that Item of the repository\'s STATUS.md (see `status`); it is refused when the repository\'s `dev` has no line for the Item, and when the Item is Blocked (it comes after Items not done: `(after: id, id)` in its line; the refusal says "blocked by ...") unless `force` is true. When the Item\'s line has `(intent: <12 hex>)`, that `intent@1` Artifact is added to the Task\'s `context` (refused unless the prefix is exactly one stored `intent@1`).',
      params: z.object({ instructions: z.string().min(1), repository: z.string().min(1).optional(), ref: z.string().min(1).optional(), context: z.array(artifactId).default([]), item: z.string().regex(ITEM_ID).optional(), against: z.string().min(1).optional(), force: z.boolean().optional() }).strict(),
      async handler(host, p, caller) {
        if (p.item && p.repository && !p.force) {
          const status = await readStatus(p.repository)
          const why = itemBlockedBy(status, status.repository, host.view.list(), p.item)
          if (why) throw new WorkError(`Item ${p.item} is ${blockedText(why)}; to store its Task on purpose, give force`)
        }
        return services.newTask(p.instructions, p.repository, p.repository ? p.ref ?? 'HEAD' : undefined, p.context, caller, p.item, p.repository ? p.against : undefined)
      },
    },
    'intent.new': {
      agent: true,
      summary: 'Store an `intent@1` Artifact, what the operator settled with a caller session before Items carry it out: `{ intent }`, the Artifact ID. `body` is Markdown (Outcome, Why, Constraints, Out of scope). With `supersedes`, the Intent replaces an earlier one, which must be a stored `intent@1` Artifact; a changed Intent is a new Intent. Set `settledByOperator: true` only when the operator settled this Intent in this session: it counts as an operator act in `work.report`; without it the Intent is not counted.',
      params: z.object({ title: z.string().min(1).max(200), body: z.string().min(1), supersedes: artifactId.optional(), settledByOperator: z.boolean().optional() }).strict(),
      handler: (_host, { settledByOperator, ...intent }, caller) => services.newIntent({ ...intent, ...(settledByOperator ? { settledBy: 'operator' as const } : {}) }, caller),
    },
    'artifact.confirm': {
      agent: true,
      summary: 'Store a `confirmation@1` Artifact: the operator confirmed the stored Artifact `subject` (a dataset, a set of labels): `{ confirmation }`, the Artifact ID. `note` says what was confirmed; `date` (default now) is when. Call it only when the operator confirmed it in this session: `work.report` counts each as an operator act.',
      params: z.object({ subject: artifactId, note: z.string().min(1).max(8 * 1024), date: z.string().min(10).max(40).optional() }).strict(),
      handler: (_host, p, caller) => services.newConfirmation(p, caller),
    },
    'defect.add': {
      agent: true,
      summary: 'Store an `escaped-defect@1` Artifact: a defect that escaped the Item (an Item ID) or the merge commit (7 to 40 hex characters) named by `subject`: `{ defect }`, the Artifact ID. `foundBy` is the Work ID that found it or text; `reason` says what was wrong; `date` (default now) is when it was found. `work.report` counts the recorded defects whose Item was merged in its range.',
      params: z.object({ subject: z.string().min(1), foundBy: z.string().min(1).max(500), reason: z.string().min(1).max(8 * 1024), date: z.string().min(10).max(40).optional() }).strict(),
      handler: (_host, p, caller) => services.newDefect(p, caller),
    },
    status: {
      read: true,
      agent: true,
      summary: 'The status of a project: one line per Item of the repository\'s `STATUS.md` on its `origin/dev` tip (else `dev`), as `[x] <id> <title> - <state>`. `done`: a Work for the Item was merged into `dev` (read from the Host\'s store), or `[x]` in `STATUS.md` for work done outside System (with the last merged Work and its final Artifact, the merged change or the report, when known; `work show` lists every Artifact); `doing`: a Work whose Task names the Item is running or held (its ID, step, Account, since when, and its live progress, or why it is held); `todo`: nobody, or `todo (blocked by <ids>)` / `todo (blocked: cycle)` for a Blocked Item (it comes after Items not done, by `(after: id, id)` at the end of its line; derived, never stored). An Item with `(intent: <12 hex>)` shows it after its title. A `done` Item whose merge commit is not in the running release says `done, not yet released`. `state` and `item` narrow it; STATUS.md lines that could not be read follow as `note:` lines, after one that names the ref read and how old it is. Read the Work by ID for details.',
      params: z.object({ repository: z.string().min(1), state: z.enum(['todo', 'doing', 'done']).optional(), item: z.string().regex(ITEM_ID).optional() }).strict(),
      async handler(host, p) {
        const status = await readStatus(p.repository)
        const records = host.view.list()
        const held = new Map<string, boolean | undefined>()
        if (services.releaseHolds) for (const commit of new Set(records.flatMap((r) => mergeCommitOf(r) ?? []))) held.set(commit, await services.releaseHolds(status.repository, commit).catch(() => undefined))
        return [...itemLines(status, status.repository, records, (workId) => host.view.live(workId), { state: p.state, item: p.item }, host.view.claims(), (c) => held.get(c)), ...[status.note, ...status.problems].map((problem) => `note: ${problem}`)]
      },
    },
    'item.claim': {
      agent: true,
      summary: 'Claim an Item of the repository\'s STATUS.md before submitting a Work for it: `{ repository, item, who, at }`, with `who` the caller\'s operator ID. `status` then shows the Item as `doing`, claimed by `who` since `at`; a Work submitted for the Item takes the claim over. Refused when the Item has no line in STATUS.md, has a running or held Work, or is claimed by another caller, unless `force` is true.',
      params: z.object({ repository: z.string().min(1), item: z.string().regex(ITEM_ID), force: z.boolean().optional(), commandId }).strict(),
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
      summary: 'The registered Workers, and each configured agent account with why it is or is not available, its label, provider account ID (never a token), a note when the profile still sets `priority` (ignored), and its last quota reading (5-hour and weekly share used, reset time, when read) or why it is unreadable.',
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
