/**
 * The `system` command line. Each action returns an exit code; the plugin
 * runs it once the host has started and then asks the launcher to exit.
 */
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { Command } from 'commander'
import { CLASSIFICATIONS, CONTENT_ID_RE, type Envelope, type ReadResult } from '@system/artifacts/contract'
import { holdDecision, TERMINAL } from '@system/work/contract'
import type { WorkRecord } from '@system/work'
import type { QuotaReport } from '@system/runtime-cli/contract'
import { MAX_FRAME, fitsFrame, schemaOf, tableOf } from '@system/host'
import { operations, type Services } from '@system/host/operations'
import { prepareRelease } from './release.ts'
import { formatReport, runDoctor, type DoctorHost } from './doctor.ts'
import { formatStoreReport, type StoreReport } from './store-check.ts'
import { carryItem, carryPass } from './items.ts'
import { readSchedule } from './schedule.ts'
import { RECONNECT_MS, readWorkflowFile, type Followed, type HostClient } from './remote.ts'

/** How long `workers.login` may take: a manual sign-in waits up to ten minutes. */
const LOGIN_TIMEOUT = 11 * 60_000
/** How long `workers.recheck` may take: a Chrome start and the page's own clocks. */
const RECHECK_TIMEOUT = 3 * 60_000

/** The optional fields of a call, left out when not given (the table's params are strict). */
const given = <T extends object>(fields: T): T => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T

const base64 = (data: Uint8Array): string => Buffer.from(data).toString('base64')

/** A repeatable option's values, in order. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

/** What a human types to confirm: the first eight characters of an ID or digest, without its prefix. */
const shortCode = (id: string): string => id.replace(/^\w+:/, '').slice(0, 8)

interface CliIo {
  out(text: string): void
  /** Warnings and notes for the operator, on stderr. */
  err(text: string): void
  write(data: Uint8Array): void
  /** A secret from the terminal without echo, or all of piped stdin. */
  readSecret(prompt: string): Promise<string>
  /**
   * Ask a human at a terminal to type `expected`; resolves the operator ID.
   * Refuses when stdin is not a terminal, whatever SYSTEM_CALLER says.
   */
  confirmHuman(prompt: string, expected: string): Promise<string>
}

interface LoginView {
  signedIn: boolean
  detail: string
  imported?: number
  skipped?: number
}

interface RecheckView {
  ready: boolean
  state: string
  detail: string
}

/** An account's note, label and provider account ID (never a credential), for the end of its line; a web account has no provider account. */
function identityOf(a: WorkersView['accounts'][number]): string {
  const parts = [...(a.note ? [a.note] : []), ...(a.label ? [`label: ${a.label}`] : []), ...(a.runtime === 'web' ? [] : [`provider account: ${a.providerAccount ?? 'unknown'}`])]
  return parts.length ? ` [${parts.join(', ')}]` : ''
}

/** `room: 3 of 8 Accounts free (slot and Headroom under Ceiling); Ready Items: System 5`; an Account with unreadable quota is counted when it has a slot, and listed apart. */
function roomLine(room: NonNullable<WorkersView['room']>): string {
  const unknown = room.unknown.length ? `; quota unknown: ${room.unknown.join(', ')}` : ''
  const ready = room.ready.map((r) => `${basename(r.repository)} ${r.count ?? 'unknown'}`).join(', ')
  return `room: ${room.free} of ${room.accounts} Accounts free (slot and Headroom under Ceiling)${unknown}${ready ? `; Ready Items: ${ready}` : ''}`
}

/** `quota: 5h 18% (resets 23:03), 7d 10%, read 2 min ago`, ending ` (from the last attempt)` for a reading told by an attempt's rate-limit event, or why it is unreadable. Reset times are local. */
export function quotaLine(quota: QuotaReport, now: number): string {
  if ('unreadable' in quota) return `quota: unreadable - ${quota.unreadable}`
  const at = (iso: string): string => {
    const d = new Date(iso)
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
  }
  const parts: string[] = []
  for (const [name, label] of [['five_hour', '5h'], ['seven_day', '7d']] as const) {
    const w = quota.windows[name]
    if (w) parts.push(`${label} ${Math.round(w.percentUsed)}%${w.resetsAt && !Number.isNaN(Date.parse(w.resetsAt)) ? ` (resets ${at(w.resetsAt)})` : ''}`)
  }
  const minutes = Math.max(0, Math.floor((now - Date.parse(quota.observedAt)) / 60_000))
  parts.push(`read ${minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`}`)
  return `quota: ${parts.join(', ')}${quota.source === 'rate_limit_event' ? ' (from the last attempt)' : ''}`
}

export interface BusyAttempt {
  account: string
  work: string
  repository?: string
  item?: string
  step: string
  since: string
  uncertain?: true
}

export interface WorkersView {
  registered: string[]
  /** How many Accounts could take one more parallel Work: see `workers.list`. */
  room?: { accounts: number; free: number; unknown: string[]; ready: { repository: string; count?: number; error?: string }[] }
  /** Worker attempts running now or holding a slot, across every repository. */
  busy?: BusyAttempt[]
  accounts: { ref: string; runtime: string; label?: string; note?: string; providerAccount?: string; available: boolean; reason: string; version?: string; abilities?: string[]; capabilities?: string[]; models?: Record<string, string>; quota?: QuotaReport }[]
}

/** What `doctor` and `host` run against: the process that boots DSH. */
export interface HostProcess extends DoctorHost {
  /** Walk every Work record and Artifact of the home, read-only (`doctor --store`). */
  checkStore(): Promise<StoreReport>
  /** Run as the Host of this home until stopped by a signal or by new code on disk; resolves its exit status once it has stopped. */
  runHost(): Promise<number>
  /** Why the profile cannot start this Host (rows to move, ADR-0018); undefined when it can. Read from the profile's patch files, which are never rewritten. */
  profileProblem(): string | undefined
}

/** A command the program selected, run after startup. */
export type Run = () => Promise<number>

const newProgram = () => new Command('system')
  .description('System: a durable work control plane for replaceable AI Workers')

/**
 * Build the program of the process that boots DSH: `doctor` and `host`.
 * `select` receives the chosen command's runner; commander only parses, so
 * nothing touches the host before startup completes.
 */
export function buildHostProgram(host: HostProcess, io: Pick<CliIo, 'out'>, select: (run: Run) => void): Command {
  const program = newProgram()
  program.command('doctor')
    .description('check the mounted composition and durable storage')
    .option('--json', 'print the report as JSON')
    .option('--store', 'instead of the composition check, walk every Work record and Artifact, read-only: each record folds, each Artifact a Work names is stored, each blob reads in full and matches its digest, each inline Artifact hashes to its ID; prints the counts and one line per problem, exits 1 on any. Safe beside a running Host (it opens SQLite as `doctor` always does and writes nothing)')
    .action((options: { json?: boolean; store?: boolean }) => {
      select(async () => {
        const problem = host.profileProblem()
        if (problem) throw new Error(problem)
        if (options.store) {
          const report = await host.checkStore()
          io.out(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatStoreReport(report))
          return report.ok ? 0 : 1
        }
        const report = await runDoctor(host)
        io.out(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
        return report.ok ? 0 : 1
      })
    })
  program.command('host')
    .description('run the Host: own every Work of this home and serve $DSH_HOME/system/host.sock until SIGTERM or SIGINT, or until the code on disk changes (exit 75)')
    // Handled by bin/system before DSH starts: the supervisor is that wrapper, which runs this command again after an exit 75.
    .option('--supervise', 'stay as a supervisor and run the Host again after an exit 75 (new code); any other exit ends it')
    .action(() => {
      select(() => {
        const problem = host.profileProblem()
        if (problem) return Promise.reject(new Error(problem))
        return host.runHost()
      })
    })
  return program
}

/** Build the thin client's program: every other command, over the Host's socket. */
/** The UTC instant a date or timestamp without a zone stands for (the Host compares ISO UTC strings), or undefined when it names a zone. */
function zonelessUtc(text: string): string | undefined {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
  if (!date && !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) return undefined
  const at = new Date(date ? text : `${text.replace(' ', 'T')}Z`)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
}

export function buildProgram(host: HostClient, io: CliIo, select: (run: Run) => void, home?: string): Command {
  const program = newProgram()
  const artifactId = (id: string): string => {
    if (!CONTENT_ID_RE.test(id)) throw new Error(`not an Artifact ID: ${id}`)
    return id
  }
  const artifact = program.command('artifact').description('store and read immutable Artifacts by ID')
  artifact.command('put <file>')
    .description('store a file as an Artifact of kind file@1 and print its ID')
    .option('--media-type <type>', 'media type of the bytes', 'application/octet-stream')
    .option('--classification <level>', 'public | operator-shared | local-private', 'local-private')
    .action((file: string, options: { mediaType: string; classification: string }) => {
      select(async () => {
        if (!(CLASSIFICATIONS as readonly string[]).includes(options.classification)) throw new Error(`unknown classification ${options.classification}`)
        const data = base64(readFileSync(file))
        if (!fitsFrame(data)) throw new Error(`${file} is too large to send to the Host (${data.length} bytes in base64; a frame holds ${MAX_FRAME})`)
        const envelope = await host.call('artifact.put', { data, mediaType: options.mediaType, classification: options.classification as (typeof CLASSIFICATIONS)[number] }) as Envelope
        io.out(`${envelope.id}\n`)
        return 0
      })
    })
  artifact.command('show <id>')
    .description('print an Artifact envelope and its occurrences as JSON')
    .action((id: string) => {
      select(async () => {
        const read = await host.call('artifact.show', { id: artifactId(id) }) as ReadResult
        io.out(`${JSON.stringify(read, null, 2)}\n`)
        return read.state === 'stored' ? 0 : 1
      })
    })
  artifact.command('cat <id>')
    .description('write the bytes of a blob Artifact to stdout')
    .action((id: string) => {
      select(async () => {
        io.write(Buffer.from((await host.call('artifact.cat', { id: artifactId(id) })).data, 'base64'))
        return 0
      })
    })
  const decide = (decision: 'approved' | 'denied') => (workIds: string[], options: { reason: string }) => {
    select(async () => {
      const records: WorkRecord[] = []
      for (const workId of workIds) {
        const record = await host.call('work.show', { workId })
        if (!record) throw new Error(`no Work ${workId}`)
        io.out(`${workId} is ${record.state.status}: ${record.state.reason ?? ''}\n`)
        io.out(holdDecision(record) ?? '')
        records.push(record)
      }
      const verb = decision === 'approved' ? 'approve' : 'deny'
      // One Work: its short ID. Several: the verb and their number, typed after reading the list above.
      const expected = workIds.length === 1 ? shortCode(workIds[0]!) : `${verb} ${workIds.length}`
      const what = workIds.length === 1 ? `${verb} ${records[0]!.state.awaiting ?? 'it'} of ${workIds[0]}` : `${verb} these ${workIds.length} Works`
      const typeWhat = workIds.length === 1 ? "the Work's short ID" : 'the verb and their number'
      // The token is alone and last on its line, so the decision word is never read as the answer.
      const operatorId = await io.confirmHuman(`To ${what}, type ${typeWhat} and press Enter, exactly: ${expected}\n> `, expected)
      let code = 0
      for (const [index, workId] of workIds.entries()) {
        const held = records[index]!
        const step = held.state.awaiting
        const commit = Object.values(held.state.effects ?? {}).find((e) => e.stepId === step && e.held)?.detail?.mergeCommit
        try {
          // What the Host recorded is said at once; then the Work is followed, one line per event, and Ctrl-C only detaches.
          const outcome = exitOf(await host.decide({ workId, decision, reason: options.reason }, operatorId, {
            recorded: () => io.out(`${decision} ${step ?? 'the decision'} of ${workId}${commit ? ` (commit ${commit.slice(0, 12)})` : ''}; following it (Ctrl-C only detaches, the Work goes on in the Host)\n`),
            onEvent: (event) => io.out(`${workId} #${event.seq} ${event.type}${event.stepId ? ` ${event.stepId}` : ''}\n`),
          }))
          code = code || outcome
        } catch (error) {
          if (workIds.length === 1) throw error
          io.err(`system: ${workId}: ${(error as Error).message}\n`)
          code = code || 1
        }
      }
      return code
    })
  }
  program.command('approve <workIds...>')
    .description('approve what each held Work awaits (an effect, or an inconclusive verdict); a human at a terminal only, one typed confirmation for all the Works given')
    .option('--reason <text>', 'why', 'approved by the operator')
    .action(decide('approved'))
  program.command('deny <workIds...>')
    .description('deny what each held Work awaits; the Work fails. A human at a terminal only, one typed confirmation for all the Works given')
    .requiredOption('--reason <text>', 'why')
    .action(decide('denied'))
  const workers = program.command('workers')
    .description('registered Workers, and each configured agent account with why it is or is not available; the last line says how many Accounts have room for more parallel Works')
    .option('--repo <path>', 'a project whose Ready Items the room line counts (repeatable)', (path: string, all: string[] = []) => [...all, path])
    .action((options: { repo?: string[] }) => {
      select(async () => {
        const { registered, accounts, room, busy } = await host.call('workers.list', given({ repository: options.repo?.map((path) => resolve(path)) })) as unknown as WorkersView
        io.out(`registered: ${registered.join(', ') || 'none'}\n`)
        for (const a of accounts) {
          io.out(`${a.ref.padEnd(22)} ${a.available ? 'available  ' : 'unavailable'} ${a.version ?? ''} ${a.available ? '' : `- ${a.reason}`}${identityOf(a)} (${a.runtime})\n`)
          // Their own lines, after the account's: tools/web-canary reads the line that ends in the runtime.
          if (a.abilities?.length) io.out(`  abilities: ${a.abilities.join(', ')}\n`)
          if (a.capabilities?.length) io.out(`  capabilities: ${a.capabilities.join(', ')}\n`)
          const models = Object.entries(a.models ?? {})
          if (models.length) io.out(`  models: ${models.map(([tier, model]) => `${tier}=${model}`).join(', ')}\n`)
          if (a.quota) io.out(`  ${quotaLine(a.quota, Date.now())}\n`)
          const on = (busy ?? []).filter((b) => b.account === a.ref)
          if (on.length) for (const b of on) io.out(`  busy: ${b.work} ${b.item ?? '-'} (${b.repository ?? '-'}) step ${b.step} since ${b.since}${b.uncertain ? ' uncertain' : ''}\n`)
          else io.out('  free\n')
        }
        if (room) io.out(`${roomLine(room)}\n`)
        return 0
      })
    })
  workers.command('login <ref>')
    .description('sign a web account (web/<site>/<name>) in: import a cookie file, sign in remotely over SSH (--remote), or without either open a window for a manual sign-in (needs a display on the Host); operators only')
    .option('--cookies <file>', 'a JSON (browser-extension export) or Netscape cookie file for chatgpt.com; read once, never stored')
    .option('--remote', 'sign in, and clear a Cloudflare challenge by hand, in a viewer you reach through an SSH tunnel; no display needed')
    .action((ref: string, options: { cookies?: string; remote?: boolean }) => {
      select(async () => {
        if (options.remote && options.cookies !== undefined) throw new Error('give --cookies or --remote, not both')
        if (options.remote) {
          const report = await host.loginRemote(ref, (view) => {
            io.out(`1. On your own machine, open the tunnel (keep it running):\n     ${view.ssh}\n`)
            io.out(`2. Open this address in your browser:\n     ${view.url}\n`)
            io.out(`3. Sign in and clear any check by hand, then press Save. The session ends at ${new Date(view.expiresAt).toLocaleTimeString()}; Ctrl-C here cancels it.\n`)
          })
          io.out(`${ref}: ${report.signedIn ? 'signed in' : `not signed in: ${report.detail}`}\n`)
          return report.signedIn ? 0 : 1
        }
        const cookies = options.cookies === undefined ? undefined : readFileSync(options.cookies, 'utf8')
        const report = await host.call('workers.login', given({ ref, cookies }), { timeout: LOGIN_TIMEOUT }) as LoginView
        if (report.imported !== undefined) io.out(`imported ${report.imported} cookie(s), skipped ${report.skipped ?? 0} of other sites\n`)
        io.out(`${ref}: ${report.signedIn ? 'signed in' : `not signed in: ${report.detail}`}\n`)
        return report.signedIn ? 0 : 1
      })
    })
  workers.command('recheck <ref>')
    .description('check a web account that is quarantined or cooling down (sign-in, Chat mode, temporary chat), sending nothing, and make it ready again only when the check passes; operators only')
    .action((ref: string) => {
      select(async () => {
        const report = await host.call('workers.recheck', { ref }, { timeout: RECHECK_TIMEOUT }) as RecheckView
        io.out(`${ref}: ${report.ready ? 'ready' : `not ready (${report.state})`}: ${report.detail}\n`)
        return report.ready ? 0 : 1
      })
    })
  const task = program.command('task').description('task inputs for Work')
  task.command('new')
    .description('store a task@1 Artifact (and, with --repo, the exact base commit) and print its ID alone on stdout; the base commit\'s ID goes to stderr')
    .option('--text <instructions>', 'the instructions')
    .option('--file <path>', 'read the instructions from a file')
    .option('--repo <path>', 'a git repository the task starts from')
    .option('--ref <ref>', 'the commit or branch in --repo', 'HEAD')
    .option('--context <id>', 'an Artifact the Worker reads as data, such as a conversation (repeatable)', collect, [])
    .option('--item <id>', 'the Item of the repository\'s STATUS.md this task is for (see system status)')
    .option('--against <ref>', 'with --repo: the commit --ref is a change from; checks are then selected by the files that differ between the two')
    .option('--force', 'store the Task although its Item is Blocked (comes after Items not done)')
    .action((options: { text?: string; file?: string; repo?: string; ref: string; context: string[]; item?: string; against?: string; force?: boolean }) => {
      select(async () => {
        if (Boolean(options.text) === Boolean(options.file)) throw new Error('give exactly one of --text and --file')
        const instructions = options.text ?? readFileSync(options.file!, 'utf8')
        const created = await host.call('task.new', given({ instructions, repository: options.repo && resolve(options.repo), ref: options.repo ? options.ref : undefined, context: options.context, item: options.item, against: options.against, force: options.force }))
        if (created.base) io.err(`base ${created.base}\n`)
        if (created.note) io.err(`note: ${created.note}\n`)
        io.out(`${created.task}\n`)
        return 0
      })
    })
  const intent = program.command('intent').description('what the operator wants, stored before Items carry it out')
  intent.command('new')
    .description('store an intent@1 Artifact (title, Markdown body: Outcome, Why, Constraints, Out of scope) and print its ID alone on stdout')
    .requiredOption('--title <title>', 'a short title')
    .option('--body <markdown>', 'the body')
    .option('--body-file <path>', 'read the body from a file')
    .option('--supersedes <id>', 'the earlier intent@1 Artifact this one replaces')
    .option('--settled-by-operator', 'the operator settled this Intent in this session (counts as an operator act in work report); set it only when they said so')
    .action((options: { title: string; body?: string; bodyFile?: string; supersedes?: string; settledByOperator?: boolean }) => {
      select(async () => {
        if (Boolean(options.body) === Boolean(options.bodyFile)) throw new Error('give exactly one of --body and --body-file')
        const body = options.body ?? readFileSync(options.bodyFile!, 'utf8')
        const created = await host.call('intent.new', given({ title: options.title, body, supersedes: options.supersedes, ...(options.settledByOperator ? { settledByOperator: true } : {}) }))
        io.out(`${created.intent}\n`)
        return 0
      })
    })
  program.command('confirm <artifact-id>')
    .description('store a confirmation@1 Artifact: the operator confirmed this stored Artifact (a dataset, a set of labels); counts as an operator act in work report; print its ID alone on stdout')
    .requiredOption('--note <text>', 'what was confirmed')
    .option('--date <date>', 'when it was confirmed (default now)')
    .action((subject: string, options: { note: string; date?: string }) => {
      select(async () => {
        const created = await host.call('artifact.confirm', given({ subject, note: options.note, date: options.date }))
        io.out(`${created.confirmation}\n`)
        return 0
      })
    })
  const release = program.command('release').description('releases: prepare one at a commit of dev; the Operator approves a commit for release')
  release.command('approve <commit>')
    .description('approve a commit of dev for release (ADR-0019): a human at a terminal types its 7 hex characters; stores a release-approval@1 Artifact and prints its ID alone on stdout. A caller session may then release that commit')
    .action((commit: string) => {
      select(async () => {
        if (!/^[0-9a-fA-F]{7,40}$/.test(commit)) throw new Error('give the commit as 7 to 40 hex characters')
        const expected = commit.slice(0, 7).toLowerCase()
        await io.confirmHuman(`Releasing ${commit} is the Operator's decision. Type its 7 hex characters and press Enter, exactly: ${expected}\n> `, expected)
        // An operator operation: it goes over the operator socket, as the Operator's.
        const created = await host.call('release.approve', given({ commit }))
        io.out(`${created.approval}\n`)
        return 0
      })
    })
  release.command('prepare <commit>')
    .description('cut a release (ADR-0019): create and push the branch release/<7 hex of the commit> at a commit of dev, and write the release report (Markdown, from records) to stdout. It never merges and never opens the pull request: run `gh pr create --base main --head release/<commit> --body-file <report>`')
    .option('--repo <path>', 'the repository (default: the current directory)', '.')
    .action((commit: string, options: { repo: string }) => {
      select(async () => {
        io.out(await prepareRelease(host, resolve(options.repo), commit))
        return 0
      })
    })
  const defect = program.command('defect').description('Escaped defects, recorded so work report counts them')
  defect.command('add <item-or-commit>')
    .description('store an escaped-defect@1 Artifact naming the Item (its ID) or the merge commit (7 to 40 hex characters) that carried the defect, and print its ID alone on stdout')
    .requiredOption('--found-by <work-or-text>', 'the Work ID that found it, or text')
    .requiredOption('--reason <text>', 'what was wrong')
    .option('--date <date>', 'when it was found (default now)')
    .option('--supersedes <id>', 'the earlier escaped-defect@1 Artifact this one replaces; it is no longer counted')
    .action((subject: string, options: { foundBy: string; reason: string; date?: string; supersedes?: string }) => {
      select(async () => {
        const created = await host.call('defect.add', given({ subject, foundBy: options.foundBy, reason: options.reason, date: options.date, supersedes: options.supersedes }))
        io.out(`${created.defect}\n`)
        return 0
      })
    })
  defect.command('withdraw <defect-id>')
    .description('store an escaped-defect-withdrawal@1 Artifact: the escaped-defect@1 Artifact was recorded wrongly and is no longer counted; print its ID alone on stdout')
    .requiredOption('--reason <text>', 'why the record is wrong')
    .option('--date <date>', 'when (default now)')
    .action((id: string, options: { reason: string; date?: string }) => {
      select(async () => {
        const created = await host.call('defect.withdraw', given({ withdraws: id, reason: options.reason, date: options.date }))
        io.out(`${created.withdrawal}\n`)
        return 0
      })
    })
  program.command('claim <item>')
    .description('claim an Item of the project\'s STATUS.md before submitting a Work for it: system status then shows it as doing, claimed by you since now; a Work submitted for the Item takes the claim over')
    .option('--repo <path>', 'a git repository of the project', '.')
    .option('--force', 'take over an Item another session has claimed')
    .action((item: string, options: { repo: string; force?: boolean }) => {
      select(async () => {
        const claim = await host.call('item.claim', given({ repository: resolve(options.repo), item, force: options.force })) as { who: string; at: string }
        io.out(`${item} claimed by ${claim.who} since ${claim.at}\n`)
        return 0
      })
    })
  const items = program.command('items').description('carry out Items of a project\'s STATUS.md')
  items.command('carry [id]')
    .description('carry one Item of STATUS.md, or without an Item ID run one pass over the given repositories in order (up to free Accounts and --max-parallel)')
    .option('--repo <path>', 'a git repository of the project (repeatable for a pass)', collect, [])
    .option('--max-parallel <n>', 'maximum Works to run in parallel during a pass')
    .option('--schedule <file>', 'a Schedule file (~/.system/schedules/<name>.yaml): its repositories and maxParallel')
    .action((id: string | undefined, options: { repo: string[]; maxParallel?: string; schedule?: string }) => {
      select(async () => {
        if (options.schedule !== undefined) {
          if (id !== undefined || options.repo.length > 0 || options.maxParallel !== undefined) throw new Error('--schedule is a pass of its own: give no Item ID, --repo or --max-parallel')
          const schedule = readSchedule(options.schedule)
          return carryPass(host, schedule.repositories, { maxParallel: schedule.maxParallel, home }, io)
        }
        if (id !== undefined) {
          if (options.repo.length > 1) throw new Error('give one --repo with an Item ID')
          if (options.maxParallel !== undefined) throw new Error('--max-parallel goes with a pass (no Item ID)')
          return carryItem(host, id, options.repo[0] ?? '.', io)
        }
        const maxParallel = options.maxParallel === undefined ? undefined : Number(options.maxParallel)
        if (maxParallel !== undefined && !(Number.isInteger(maxParallel) && maxParallel >= 1)) {
          throw new Error('--max-parallel is a positive integer')
        }
        return carryPass(host, options.repo, { maxParallel, home }, io)
      })
    })
  program.command('schema')
    .description('print the operation table as JSON: each operation\'s name, summary, Authority, read or write, whether a write is destructive, and its parameters (the MCP tools and their annotations come from the same table); needs no Host')
    .action(() => {
      select(async () => {
        io.out(`${JSON.stringify(schemaOf(tableOf(operations({} as Services))), null, 2)}\n`)
        return 0
      })
    })
  program.command('status')
    .description('the status of a project: one line per Item of its STATUS.md on dev, done, doing (which Work, step, account, since when, progress) or todo (nobody)')
    .option('--repo <path>', 'a git repository of the project', '.')
    .option('--state <state>', 'only Items that are todo, doing or done')
    .option('--item <id>', 'only this Item')
    .action((options: { repo: string; state?: string; item?: string }) => {
      select(async () => {
        if (options.state && !['todo', 'doing', 'done'].includes(options.state)) throw new Error('--state is todo, doing or done')
        for (const line of await host.call('status', given({ repository: resolve(options.repo), state: options.state as 'todo' | 'doing' | 'done' | undefined, item: options.item }))) io.out(`${line}\n`)
        return 0
      })
    })
  const credentials = program.command('credentials').description('store Worker tokens in the DSH credential store; values are never printed')
  credentials.command('set <name>')
    .description('read a value without echo (or from piped stdin) and store it under <name>')
    .action((name: string) => {
      select(async () => {
        const value = await io.readSecret(`${name}: `)
        if (!value) throw new Error('no value given; nothing stored')
        await host.call('credentials.set', { name, value })
        io.out(`stored ${name}\n`)
        return 0
      })
    })
  credentials.command('status <names...>')
    .description('whether each name is configured, and from where')
    .action((names: string[]) => {
      select(async () => {
        let missing = 0
        for (const name of names) {
          const info = (await host.call('credentials.status', { names: [name] }))[0]!
          if (!info.configured) missing += 1
          io.out(`${name}  ${info.configured ? `configured (${info.source})` : 'not configured'}\n`)
        }
        return missing ? 1 : 0
      })
    })
  const work = program.command('work').description('submit, run, inspect and replay Work')
  work.command('submit')
    .description('admit Work from a Workflow file, or a single Task by capability, then run it')
    .option('--workflow <file>', 'a system.workflow/v1 YAML file')
    .option('--capability <name...>', 'a single Task needing these Worker capabilities (no Workflow file)')
    .option('--input <artifactId>', 'the input Artifact')
    .option('--worker <ref>', 'only this Worker may take its Worker steps (see system workers)')
    .option('--force', 'admit although the input Task\'s Item already has a running or held Work, or is Blocked')
    .option('--no-run', 'admit only')
    .option('--cancel-on-interrupt', 'at Ctrl-C cancel the Work and follow it to its end (without it, Ctrl-C detaches and the Work goes on in the Host)')
    .action((options: { workflow?: string; capability?: string[]; input?: string; worker?: string; force?: boolean; run: boolean; cancelOnInterrupt?: boolean }) => {
      select(async () => {
        if (Boolean(options.workflow) === Boolean(options.capability)) throw new Error('give exactly one of --workflow and --capability')
        const admitted = await host.call('work.submit', given({ ...(options.workflow ? readWorkflowFile(options.workflow) : { capabilities: options.capability }), input: options.input, worker: options.worker, force: options.force, run: false }))
        io.out(`${admitted.id}\n`)
        if (!options.run) return 0
        return exitOf(await host.run(admitted.id, { cancelOnInterrupt: options.cancelOnInterrupt }))
      })
    })
  work.command('cancel <workId>')
    .description('stop running Work: its attempt gets SIGTERM, then SIGKILL after 30 s; partial output is kept, unaccepted')
    .option('--reason <text>', 'why', 'cancelled by the operator')
    .option('--wait', 'wait until the running host has recorded the cancellation')
    .action((workId: string, options: { reason: string; wait?: boolean }) => {
      select(async () => {
        const outcome = await host.call('work.cancel', { workId, reason: options.reason })
        if (outcome !== 'requested') {
          io.out(`${workId} cancelled\n`)
          return exitCode(outcome.state.status)
        }
        io.out(`${workId}: cancellation requested from the running host\n`)
        if (!options.wait) return 0
        if (await host.wait(workId) !== 'detached') io.out(`${workId}: the running host has stopped; see system work show\n`)
        return 0
      })
    })
  /** Whether `step` of the Work's pinned spec is a verify step. */
  const isVerifyStep = async (workId: string, step: string): Promise<boolean> => {
    const record = await host.call('work.show', { workId })
    if (!record) throw new Error(`no Work ${workId}`)
    const read = await host.call('artifact.show', { id: record.state.specId }) as ReadResult
    const steps = read.state === 'stored' ? (read.envelope.content as { steps?: object[] }).steps ?? [] : []
    return steps.some((s) => (s as { id?: string }).id === step && 'verify' in s)
  }
  work.command('retry <workId>')
    .description('run a step of failed, cancelled or held Work again as a new attempt; the steps after it are reset. A verify step is asked again on the same subject and criteria')
    .option('--step <id>', 'the Worker, verify or effect step to run again (default: the first Worker step that did not succeed)')
    .option('--worker <ref>', 'only this Worker may take it over (see system workers)')
    .option('--reason <text>', 'why', 'retried by the operator')
    .option('--cancel-on-interrupt', 'at Ctrl-C cancel the Work and follow it to its end (without it, Ctrl-C detaches)')
    .action((workId: string, options: { step?: string; worker?: string; reason: string; cancelOnInterrupt?: boolean }) => {
      select(async () => {
        // Choosing among runs of a check is the operator's (ADR-0011): the same typed confirmation as `system approve`.
        if (options.step && await isVerifyStep(workId, options.step)) {
          if (options.worker) throw new Error(`${options.step} is a verify step; --worker names Workers only`)
          await io.confirmHuman(`Verifying again is a human's decision. Type exactly ${shortCode(workId)} to run ${options.step} again\n> `, shortCode(workId))
          // An operator operation: it goes over the operator socket, as the Operator's.
          await host.call('work.verifyAgain', given({ workId, step: options.step, reason: options.reason }))
          return exitOf(await host.wait(workId, { cancelOnInterrupt: options.cancelOnInterrupt }))
        }
        return exitOf(await host.retry(given({ workId, worker: options.worker, reason: options.reason, step: options.step }), { cancelOnInterrupt: options.cancelOnInterrupt }))
      })
    })
  work.command('run <workId>')
    .description('advance admitted or interrupted Work until it is terminal')
    .option('--cancel-on-interrupt', 'at Ctrl-C cancel the Work and follow it to its end (without it, Ctrl-C detaches)')
    .action((workId: string, options: { cancelOnInterrupt?: boolean }) => {
      select(async () => {
        return exitOf(await host.run(workId, { cancelOnInterrupt: options.cancelOnInterrupt }))
      })
    })
  work.command('wait <workId...>')
    .description('return when every Work, or with --any the first, has ended, is held or awaits approval; one line per Work (or one JSON object per Work with --json). Exit: with --any the code of the first Work to end; otherwise the worst among the Works (failed, cancelled, held, succeeded; 0 succeeded, 1 failed, 3 held or awaiting the Operator, 5 cancelled), 4 on timeout, 6 when the Host stayed unreachable')
    .option('--any', 'return at the first Work that ended, not when all have')
    .option('--timeout <minutes>', 'give up after this many minutes (exit 4; exit 6 if the Host was unreachable)')
    .option('--json', 'print one JSON object per Work (NDJSON)')
    .action((workIds: string[], options: { any?: boolean; timeout?: string; json?: boolean }) => {
      select(async () => {
        let timeoutMs: number | undefined
        if (options.timeout !== undefined) {
          const minutes = Number(options.timeout)
          if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('--timeout takes a positive number of minutes')
          timeoutMs = minutes * 60_000
        }
        const waited = await host.waitFor(workIds, { any: Boolean(options.any), timeoutMs })
        if (waited.unreachable !== undefined) {
          if (options.json) {
            for (const workId of workIds) {
              io.out(`${JSON.stringify({ id: workId, outcome: 'unreachable', exitCode: EXIT_HOST_UNREACHABLE, reason: waited.unreachable })}\n`)
            }
          }
          io.err(`system: the System Host did not answer for ${Math.round((timeoutMs === undefined ? RECONNECT_MS : Math.min(timeoutMs, RECONNECT_MS)) / 60_000 * 10) / 10} minutes; the Works were not read and may still be running (exit ${EXIT_HOST_UNREACHABLE}); see docs/operations/recovery.md, "The Host is not answering"\n`)
          return EXIT_HOST_UNREACHABLE
        }
        for (const { id, state } of waited.records) {
          const why = state.reason ?? (state.status === 'held' && state.awaiting ? `awaiting ${state.awaiting}` : undefined)
          if (options.json) {
            const isTimeout = waited.timedOut && !TERMINAL.has(state.status)
            const outcome = isTimeout ? 'timeout' : state.status
            const code = isTimeout ? 4 : exitCode(state.status)
            io.out(`${JSON.stringify({ id, status: state.status, outcome, exitCode: code, ...(state.awaiting ? { awaiting: state.awaiting } : {}), ...(why ? { reason: why } : {}) })}\n`)
          } else {
            io.out(`${id}  ${state.status}${why ? `  ${why}` : ''}\n`)
          }
        }
        if (waited.timedOut) {
          io.err(`system: timed out after ${options.timeout} minutes; the Works above had not ended (exit 4)\n`)
          return 4
        }
        if (options.any) {
          const decider = waited.records.find((record) => record.id === waited.decided)
          return decider ? exitCode(decider.state.status) : 0
        }
        return exitCode(worst(waited.records.map((record) => record.state.status)))
      })
    })
  work.command('show <workId>')
    .description('print the Work record (events and state) as JSON; a held Work first states its decision on stderr: the step, reason, options and the command for each')
    .action((workId: string) => {
      select(async () => {
        const record = await host.call('work.show', { workId })
        if (!record) throw new Error(`no Work ${workId}`)
        // On stderr, above the record in a terminal: stdout stays the record's JSON for every reader that parses it.
        io.err(holdDecision(record) ?? '')
        io.out(`${JSON.stringify(record, null, 2)}\n`)
        return 0
      })
    })
  work.command('list')
    .description('list Work, one per line: id, status, pinned spec and the Item its Task names (when it names one)')
    .option('--since <iso>', 'only the Works admitted at or after this date or timestamp (inclusive)')
    .action((options: { since?: string }) => {
      select(async () => {
        for (const work of await host.call('work.list', given({ since: options.since }))) io.out(`${work.id}  ${work.status.padEnd(21)}  ${work.specId}${work.item ? `  ${work.item}` : ''}\n`)
        return 0
      })
    })
  work.command('report [workId]')
    .description('duration, attempts, operator touches and usage of a Work, from its events; or with --since, the headline (Items merged per operator act: Intents settled, confirmations, releases the Operator made, human touches; `releasesByCaller`, releases a caller made under the delegation, are reported apart and not counted) and the five measures of effect (verified success, recurring failure, escaped defect, cost per verified Work, time to verified resolution) over the Works admitted in the range, with their counts, and recurringClasses: the failure classes seen 2 or more times, most frequent first (top 10, with the latest Work as example)')
    .option('--since <date>', 'the range starts at this date or timestamp (inclusive)')
    .option('--until <date>', 'the range ends before this date or timestamp (default: now)')
    .option('--escaped <n>', 'an explicit count of the Escaped defects of the range that replaces the recorded ones (`system defect add`); the report labels it an override')
    .option('--classify', 'with a Work ID: first ask the Classifier (the optional classifier row) for the failures no rule places, then report; a Work that has ended is classified by the Host anyway')
    .action((workId: string | undefined, options: { since?: string; until?: string; escaped?: string; classify?: boolean }) => {
      select(async () => {
        if ((workId === undefined) === (options.since === undefined)) throw new Error('give a Work ID, or --since <date> for a range')
        if (workId !== undefined && (options.until !== undefined || options.escaped !== undefined)) throw new Error('--until and --escaped go with --since')
        if (workId === undefined && options.classify) throw new Error('--classify goes with a Work ID')
        if (workId !== undefined) {
          let report: unknown = await host.call('work.report', given({ workId, classify: options.classify || undefined }))
          // The Host bounds a call; classification still going on is asked about again until it is done.
          for (let n = 0; options.classify && (report as { classifying?: boolean }).classifying && n < 600; n += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000))
            report = await host.call('work.report', { workId, classify: true })
          }
          io.out(`${JSON.stringify(report, null, 2)}\n`)
          return 0
        }
        const escaped = options.escaped === undefined ? undefined : Number(options.escaped)
        if (escaped !== undefined && !(Number.isInteger(escaped) && escaped >= 0)) throw new Error('--escaped is a count')
        const report = await host.call('work.report', { since: options.since!, ...(options.until === undefined ? {} : { until: options.until }), ...(escaped === undefined ? {} : { escaped }) })
        // A date with no zone is read as UTC, not as the caller's local time: say which instant that is.
        const sinceUtc = zonelessUtc(options.since!)
        if (sinceUtc) io.err(`system: --since ${options.since} has no zone and is read as UTC: ${sinceUtc}\n`)
        for (const v of (report as { releaseViolations?: { merge: string; paths: string[] }[] }).releaseViolations ?? []) io.err(`system: release ${v.merge.slice(0, 12)} by a caller touched what is not delegated: ${v.paths.join(', ')}\n`)
        const cost = (report as { costPerVerifiedWork?: { usd: number | string; accepted: number; acceptedWithKnownCost: number } }).costPerVerifiedWork
        if (cost) io.err(`system: cost per verified Work: ${typeof cost.usd === 'number' ? `$${cost.usd.toFixed(2)}` : cost.usd} over ${cost.acceptedWithKnownCost} of ${cost.accepted} accepted Works\n`)
        io.out(`${JSON.stringify(sinceUtc ? { ...(report as object), sinceUtc } : report, null, 2)}\n`)
        return 0
      })
    })
  work.command('replay <workId>')
    .description('fold the recorded events again and compare with the stored state; runs nothing')
    .action((workId: string) => {
      select(async () => {
        const replayed = await host.call('work.replay', { workId }) as { state: unknown; matches: boolean }
        io.out(`${JSON.stringify(replayed, null, 2)}\n`)
        return replayed.matches ? 0 : 1
      })
    })
  return program
}

/** The exit code of a followed Work; leaving it running in the Host is not a failure. */
const exitOf = (followed: Followed): number => (typeof followed === 'string' ? 0 : exitCode(followed.state.status))

/** The worst of ended statuses: failed, then cancelled (an operator stopped it), then held, then succeeded; others are ignored. */
const worst = (statuses: string[]): string => {
  const rank = ['failed', 'cancelled', 'held', 'succeeded']
  return rank.find((status) => statuses.includes(status)) ?? 'succeeded'
}

/** `work wait` exit code when the Host stayed unreachable for the bound: not a Work's status, never 0. */
const EXIT_HOST_UNREACHABLE = 6

/** succeeded 0, failed 1, held for the operator 3, not terminal 4, cancelled 5 (6 is `work wait`'s, not a Work status). */
export function exitCode(status: string): number {
  return { succeeded: 0, failed: 1, held: 3, cancelled: 5 }[status] ?? 4
}
