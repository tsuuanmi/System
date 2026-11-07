/**
 * The `system` command line. Each action returns an exit code; the plugin
 * runs it once the host has started and then asks the launcher to exit.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { Command } from 'commander'
import type { Envelope, ReadResult } from '@system/artifacts'
import { CONVERSATION_KIND, assertedSchema, conversationSchema, previewConversation, type Asserted, type ConversationParts, type GoalView, type NewDecision, type NewGoal, type StoredDecision, type WorkRecord, type WorkState } from '@system/work'
import { formatReport, runDoctor, type DoctorHost } from './doctor.ts'

/** A repeatable option's values, in order. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value]
}

/** A whole number above zero, for an option. */
const positive = (name: string) => (text: string): number => {
  const value = Number(text)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} is a whole number above zero, not ${text}`)
  return value
}

/** What a human types to confirm: the first eight characters of an ID or digest, without its prefix. */
const shortCode = (id: string): string => id.replace(/^\w+:/, '').slice(0, 8)

const MEDIA_TYPES: Record<string, string> = { '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html', '.pdf': 'application/pdf' }
const mediaTypeOf = (path: string) => MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'

export interface CliIo {
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

/** The credential operations the CLI offers; values go in, never out. */
export interface CredentialCommands {
  set(name: string, value: string): Promise<void>
  describe(name: string): Promise<{ configured: boolean; source?: string }>
}

/** The Artifact operations the CLI offers, resolved against the running host. */
export interface ArtifactCommands {
  putFile(path: string, mediaType: string, classification: string): Promise<Envelope>
  get(id: string): Soon<ReadResult>
  readBytes(id: string): Promise<Uint8Array>
}

/** What a command that follows a Work accepts: Ctrl-C detaches, or with this cancels the Work and goes on following it. */
export interface FollowOptions {
  cancelOnInterrupt?: boolean
}

/** A Work's record once it is terminal, or `detached` when the operator left it running in the Host. */
export type Followed = WorkRecord | 'detached'

/** A value now, or when the Host has answered. */
type Soon<T> = T | Promise<T>

/** The Work operations the CLI offers. */
export interface WorkCommands {
  admitFile(path: string, input: string | undefined, goal?: string, worker?: string): Promise<WorkRecord>
  admitTask(capabilities: string[], input: string | undefined, goal?: string, worker?: string): Promise<WorkRecord>
  /** Start the Work in the Host and follow it until it is terminal. */
  run(workId: string, follow?: FollowOptions): Promise<Followed>
  get(workId: string): Soon<WorkRecord | undefined>
  list(): Soon<{ id: string; status: string; specId: string }[]>
  replay(workId: string): Soon<{ state: WorkState; matches: boolean }>
  cancel(workId: string, reason: string): Promise<'requested' | WorkRecord>
  decide(workId: string, decision: 'approved' | 'denied', operatorId: string, reason: string): Promise<Followed>
  retry(workId: string, worker: string | undefined, reason: string, step: string | undefined, follow?: FollowOptions): Promise<Followed>
  /** Wait until nothing runs the Work, as after a cancel was requested. */
  wait(workId: string): Promise<Followed>
  /** A Work's measurements, and for a Work of a Goal the Goal's budget and spend. */
  report(workId: string): Promise<unknown>
  /** Store a Goal on the human's own connection, as the operator who confirmed it; `supersedes` is the Goal it raises or changes. */
  newGoal(goal: NewGoal, supersedes: string | undefined, operatorId: string): Promise<{ id: string }>
  goal(goalId: string): Promise<GoalView>
  /** The Goal's brief: text written from records only. */
  brief(goalId: string): Promise<string>
  addDecision(decision: NewDecision): Promise<{ id: string }>
  decisions(goalId: string | undefined): Promise<StoredDecision[]>
  newTask(instructions: string, repository: string | undefined, ref: string | undefined, context: string[]): Promise<{ task: string; base?: string }>
  addConversation(parts: ConversationParts, asserted: Asserted, supersedes: string[]): Promise<{ id: string }>
}

export interface LoginView {
  signedIn: boolean
  detail: string
  imported?: number
  skipped?: number
}

export interface RecheckView {
  ready: boolean
  state: string
  detail: string
}

export interface RemoteLoginView {
  url: string
  port: number
  ssh: string
  expiresAt: number
}

export interface WorkersView {
  registered: string[]
  accounts: { ref: string; runtime: string; available: boolean; reason: string; version?: string }[]
}

/** What the thin client's commands run against: the Host, over its socket. */
export interface ClientHost {
  artifacts(): ArtifactCommands
  work(): WorkCommands
  credentials(): CredentialCommands
  workers(): Promise<WorkersView>
  login(ref: string, cookies: string | undefined): Promise<LoginView>
  /** Check an account that is quarantined or cooling down, sending nothing; ready again only when the check passes. */
  recheck(ref: string): Promise<RecheckView>
  /** The remote sign-in: `show` is given where to reach the viewer once it is up; resolves when it ends. Ctrl-C cancels it. */
  loginRemote(ref: string, show: (view: RemoteLoginView) => void): Promise<LoginView>
}

/** What `doctor` and `host` run against: the process that boots DSH. */
export interface HostProcess extends DoctorHost {
  /** Run as the Host of this home until stopped by a signal or by new code on disk; resolves its exit status once it has stopped. */
  runHost(): Promise<number>
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
    .action((options: { json?: boolean }) => {
      select(async () => {
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
      select(() => host.runHost())
    })
  return program
}

/** Build the thin client's program: every other command, over the Host's socket. */
export function buildProgram(host: ClientHost, io: CliIo, select: (run: Run) => void): Command {
  const program = newProgram()
  const artifact = program.command('artifact').description('store and read immutable Artifacts by ID')
  artifact.command('put <file>')
    .description('store a file as an Artifact of kind file@1 and print its ID')
    .option('--media-type <type>', 'media type of the bytes', 'application/octet-stream')
    .option('--classification <level>', 'public | operator-shared | local-private', 'local-private')
    .action((file: string, options: { mediaType: string; classification: string }) => {
      select(async () => {
        const envelope = await host.artifacts().putFile(file, options.mediaType, options.classification)
        io.out(`${envelope.id}\n`)
        return 0
      })
    })
  artifact.command('show <id>')
    .description('print an Artifact envelope and its occurrences as JSON')
    .action((id: string) => {
      select(async () => {
        const read = await host.artifacts().get(id)
        io.out(`${JSON.stringify(read, null, 2)}\n`)
        return read.state === 'stored' ? 0 : 1
      })
    })
  artifact.command('cat <id>')
    .description('write the bytes of a blob Artifact to stdout')
    .action((id: string) => {
      select(async () => {
        io.write(await host.artifacts().readBytes(id))
        return 0
      })
    })
  const decide = (decision: 'approved' | 'denied') => (workId: string, options: { reason: string }) => {
    select(async () => {
      const record = await host.work().get(workId)
      if (!record) throw new Error(`no Work ${workId}`)
      io.out(`${workId} is ${record.state.status}: ${record.state.reason ?? ''}\n`)
      const short = shortCode(workId)
      // On a line of its own, so a pasted command is not taken for the answer.
      const operatorId = await io.confirmHuman(`Nothing is decided unless you type exactly ${short} to record "${decision}" for ${record.state.awaiting ?? 'it'}\n> `, short)
      return exitOf(await host.work().decide(workId, decision, operatorId, options.reason))
    })
  }
  program.command('approve <workId>')
    .description('approve what held Work awaits (an effect, or an inconclusive verdict); a human at a terminal only')
    .option('--reason <text>', 'why', 'approved by the operator')
    .action(decide('approved'))
  program.command('deny <workId>')
    .description('deny what held Work awaits; the Work fails. A human at a terminal only')
    .requiredOption('--reason <text>', 'why')
    .action(decide('denied'))
  const workers = program.command('workers')
    .description('registered Workers, and each configured agent account with why it is or is not available')
    .action(() => {
      select(async () => {
        const { registered, accounts } = await host.workers()
        io.out(`registered: ${registered.join(', ') || 'none'}\n`)
        for (const a of accounts) {
          io.out(`${a.ref.padEnd(22)} ${a.available ? 'available  ' : 'unavailable'} ${a.version ?? ''} ${a.available ? '' : `- ${a.reason}`} (${a.runtime})\n`)
        }
        return 0
      })
    })
  workers.command('login <ref>')
    .description('sign a chatgpt-web account in: import a cookie file, sign in remotely over SSH (--remote), or without either open a window for a manual sign-in (needs a display on the Host); operators only')
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
        const report = await host.login(ref, options.cookies === undefined ? undefined : readFileSync(options.cookies, 'utf8'))
        if (report.imported !== undefined) io.out(`imported ${report.imported} cookie(s), skipped ${report.skipped ?? 0} of other sites\n`)
        io.out(`${ref}: ${report.signedIn ? 'signed in' : `not signed in: ${report.detail}`}\n`)
        return report.signedIn ? 0 : 1
      })
    })
  workers.command('recheck <ref>')
    .description('check a chatgpt-web account that is quarantined or cooling down (sign-in, Chat mode, temporary chat), sending nothing, and make it ready again only when the check passes; operators only')
    .action((ref: string) => {
      select(async () => {
        const report = await host.recheck(ref)
        io.out(`${ref}: ${report.ready ? 'ready' : `not ready (${report.state})`}: ${report.detail}\n`)
        return report.ready ? 0 : 1
      })
    })
  const task = program.command('task').description('task inputs for Work')
  task.command('new')
    .description('store a task@1 Artifact (and, with --repo, the exact base commit) and print its ID')
    .option('--text <instructions>', 'the instructions')
    .option('--file <path>', 'read the instructions from a file')
    .option('--repo <path>', 'a git repository the task starts from')
    .option('--ref <ref>', 'the commit or branch in --repo', 'HEAD')
    .option('--context <id>', 'an Artifact the Worker reads as data, such as a conversation (repeatable)', collect, [])
    .action((options: { text?: string; file?: string; repo?: string; ref: string; context: string[] }) => {
      select(async () => {
        if (Boolean(options.text) === Boolean(options.file)) throw new Error('give exactly one of --text and --file')
        const instructions = options.text ?? readFileSync(options.file!, 'utf8')
        const created = await host.work().newTask(instructions, options.repo, options.repo ? options.ref : undefined, options.context)
        if (created.base) io.out(`base ${created.base}\n`)
        io.out(`${created.task}\n`)
        return 0
      })
    })
  const goal = program.command('goal').description('Goals: an aim, its scope and its budget, which Works are admitted under')
  goal.command('new')
    .description('store a goal@1 Artifact and print its ID; a human at a terminal only. A raise or a change supersedes the old Goal')
    .requiredOption('--aim <text>', 'what to achieve')
    .requiredOption('--scope <text>', 'what is in and out')
    .option('--attempts <n>', 'the most Worker attempts its Works may spend', positive('--attempts'))
    .option('--tokens <n>', 'the most tokens (fresh input plus output) its Works may spend', positive('--tokens'))
    .option('--supersedes <id>', 'the Goal this raises or changes')
    .option('--context <id>', 'an Artifact every Work of the Goal reads as data (repeatable; default: the Charter)', collect, [])
    .action((options: { aim: string; scope: string; attempts?: number; tokens?: number; supersedes?: string; context: string[] }) => {
      select(async () => {
        const budget = { ...(options.attempts ? { attempts: options.attempts } : {}), ...(options.tokens ? { tokens: options.tokens } : {}) }
        const content = { aim: options.aim, scope: options.scope, budget, ...(options.context.length ? { context: options.context } : {}) }
        io.out(`${JSON.stringify({ ...content, ...(options.supersedes ? { supersedes: options.supersedes } : {}) }, null, 2)}\n`)
        const short = shortCode(`sha256:${createHash('sha256').update(JSON.stringify([content, options.supersedes])).digest('hex')}`)
        // On a line of its own, so a pasted command is not taken for the answer.
        const operatorId = await io.confirmHuman(`Nothing is stored unless you type exactly ${short} to write this Goal\n> `, short)
        io.out(`${(await host.work().newGoal(content, options.supersedes, operatorId)).id}\n`)
        return 0
      })
    })
  goal.command('show <id>')
    .description('a Goal, its current version (the newest that supersedes it) and the spend of its Works')
    .action((id: string) => {
      select(async () => {
        io.out(`${JSON.stringify(await host.work().goal(id), null, 2)}\n`)
        return 0
      })
    })
  goal.command('brief <id>')
    .description('what a new Orchestrator session starts from, written from records only: the Goal and its budget left, its Works, its decisions and what waits')
    .action((id: string) => {
      select(async () => {
        io.out(await host.work().brief(id))
        return 0
      })
    })
  const decision = program.command('decision').description('choices made for a Goal, recorded as Artifacts: a record, never an authority')
  decision.command('add')
    .description('record a decision for a Goal and print its ID')
    .requiredOption('--goal <id>', 'the Goal it is made for')
    .requiredOption('--question <text>', 'what was decided')
    .requiredOption('--option <text>', 'an option considered (repeatable)', collect, [])
    .requiredOption('--choice <text>', 'the option chosen')
    .requiredOption('--reason <text>', 'why')
    .option('--rests-on <id>', 'an Artifact it rests on, such as a synthesis, a review or a check-run (repeatable)', collect, [])
    .action((options: { goal: string; question: string; option: string[]; choice: string; reason: string; restsOn: string[] }) => {
      select(async () => {
        const { goal: goalId, question, option, choice, reason, restsOn } = options
        io.out(`${(await host.work().addDecision({ goal: goalId, question, options: option, choice, reason, restsOn })).id}\n`)
        return 0
      })
    })
  decision.command('list')
    .description('the decisions of a Goal and its chain (of every Goal without --goal), oldest first, as JSON')
    .option('--goal <id>', 'the Goal')
    .action((options: { goal?: string }) => {
      select(async () => {
        io.out(`${JSON.stringify(await host.work().decisions(options.goal), null, 2)}\n`)
        return 0
      })
    })
  const conversation = program.command('conversation').description('take in a conversation held elsewhere, such as in a web chat, as operator-supplied Artifacts')
  conversation.command('add')
    .description('preview a conversation, or with --yes store it and print its ID')
    .requiredOption('--response <file>', 'the response, or the part of the conversation kept')
    .option('--prompt <file>', 'what was asked')
    .option('--attach <file>', 'another file, such as a raw export (repeatable)', collect, [])
    .option('--provider <name>', 'the product, as you state it')
    .option('--url <url>', 'where the conversation is, as you state it')
    .option('--model <name>', 'the model the product showed, as you state it')
    .option('--captured-at <time>', 'when you copied it')
    .option('--selection <how>', 'complete, excerpts or summary')
    .option('--product-context <flag>', 'context the product used that the files do not show, such as browsing or memory (repeatable)', collect, [])
    .option('--supersedes <id>', 'a conversation this one corrects (repeatable)', collect, [])
    .option('--yes', 'store it (without it, nothing is stored)')
    .option('--accept-warnings', 'with --yes, store it although the preview has warnings')
    .action((options: { response: string; prompt?: string; attach: string[]; provider?: string; url?: string; model?: string; capturedAt?: string; selection?: string; productContext: string[]; supersedes: string[]; yes?: boolean; acceptWarnings?: boolean }) => {
      select(async () => {
        const part = (path: string) => ({ name: basename(path), data: readFileSync(path), mediaType: mediaTypeOf(path) })
        const parts: ConversationParts = { response: part(options.response), ...(options.prompt ? { prompt: part(options.prompt) } : {}), attachments: options.attach.map(part) }
        const asserted = assertedSchema.parse({
          provider: options.provider, url: options.url, model: options.model, capturedAt: options.capturedAt,
          selection: options.selection, context: options.productContext.length ? options.productContext : undefined,
        })
        const preview = previewConversation(parts, asserted)
        for (const warning of preview.warnings) io.err(`warning: ${warning}\n`)
        if (!options.yes) {
          for (const p of preview.parts) io.out(`${p.role.padEnd(10)} ${p.name}  ${p.bytes} bytes  ${p.firstLine}\n`)
          io.out('nothing stored; run again with --yes to store it (it cannot be changed or deleted afterwards)\n')
          return 0
        }
        if (preview.warnings.length && !options.acceptWarnings) throw new Error('the preview has warnings; nothing stored. Remove what it names, or add --accept-warnings to store it anyway')
        io.out(`${(await host.work().addConversation(parts, asserted, options.supersedes)).id}\n`)
        return 0
      })
    })
  conversation.command('show <id>')
    .description('print a conversation\'s notice, what the operator asserted, and its parts')
    .action((id: string) => {
      select(async () => {
        const read = await host.artifacts().get(id)
        if (read.state !== 'stored' || read.envelope.kind !== CONVERSATION_KIND.kind) throw new Error(`${id} is not a stored conversation`)
        const content = conversationSchema.parse(read.envelope.content)
        io.out(`${content.notice}\n\n`)
        for (const [key, value] of Object.entries(content.asserted)) io.out(`${key}: ${Array.isArray(value) ? value.join(', ') : value}\n`)
        for (const o of read.occurrences) io.out(`added by ${o.producer.ref} at ${o.at}\n`)
        if (read.envelope.lineage.supersedes) io.out(`corrects ${read.envelope.lineage.supersedes.join(', ')}\n`)
        io.out('\n')
        for (const p of content.parts) io.out(`${p.role.padEnd(10)} ${p.name}  ${p.bytes} bytes  ${p.artifact}\n`)
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
        await host.credentials().set(name, value)
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
          const info = await host.credentials().describe(name)
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
    .option('--goal <id>', 'count the Work toward this Goal: its context goes to the Task and its budget limits admission')
    .option('--worker <ref>', 'only this Worker may take its Worker steps (see system workers)')
    .option('--no-run', 'admit only')
    .option('--cancel-on-interrupt', 'at Ctrl-C cancel the Work and follow it to its end (without it, Ctrl-C detaches and the Work goes on in the Host)')
    .action((options: { workflow?: string; capability?: string[]; input?: string; goal?: string; worker?: string; run: boolean; cancelOnInterrupt?: boolean }) => {
      select(async () => {
        if (Boolean(options.workflow) === Boolean(options.capability)) throw new Error('give exactly one of --workflow and --capability')
        const commands = host.work()
        const admitted = options.workflow
          ? await commands.admitFile(options.workflow, options.input, options.goal, options.worker)
          : await commands.admitTask(options.capability!, options.input, options.goal, options.worker)
        io.out(`${admitted.id}\n`)
        if (!options.run) return 0
        return exitOf(await commands.run(admitted.id, { cancelOnInterrupt: options.cancelOnInterrupt }))
      })
    })
  work.command('cancel <workId>')
    .description('stop running Work: its attempt gets SIGTERM, then SIGKILL after 30 s; partial output is kept, unaccepted')
    .option('--reason <text>', 'why', 'cancelled by the operator')
    .option('--wait', 'wait until the running host has recorded the cancellation')
    .action((workId: string, options: { reason: string; wait?: boolean }) => {
      select(async () => {
        const outcome = await host.work().cancel(workId, options.reason)
        if (outcome !== 'requested') {
          io.out(`${workId} cancelled\n`)
          return exitCode(outcome.state.status)
        }
        io.out(`${workId}: cancellation requested from the running host\n`)
        if (!options.wait) return 0
        if (await host.work().wait(workId) !== 'detached') io.out(`${workId}: the running host has stopped; see system work show\n`)
        return 0
      })
    })
  work.command('retry <workId>')
    .description('run a step of failed, cancelled or held Work again as a new attempt; the steps after it are reset. A verify step is asked again on the same subject and criteria')
    .option('--step <id>', 'the Worker, verify or effect step to run again (default: the first Worker step that did not succeed)')
    .option('--worker <ref>', 'only this Worker may take it over (see system workers)')
    .option('--reason <text>', 'why', 'retried by the operator')
    .option('--cancel-on-interrupt', 'at Ctrl-C cancel the Work and follow it to its end (without it, Ctrl-C detaches)')
    .action((workId: string, options: { step?: string; worker?: string; reason: string; cancelOnInterrupt?: boolean }) => {
      select(async () => {
        return exitOf(await host.work().retry(workId, options.worker, options.reason, options.step, { cancelOnInterrupt: options.cancelOnInterrupt }))
      })
    })
  work.command('run <workId>')
    .description('advance admitted or interrupted Work until it is terminal')
    .option('--cancel-on-interrupt', 'at Ctrl-C cancel the Work and follow it to its end (without it, Ctrl-C detaches)')
    .action((workId: string, options: { cancelOnInterrupt?: boolean }) => {
      select(async () => {
        return exitOf(await host.work().run(workId, { cancelOnInterrupt: options.cancelOnInterrupt }))
      })
    })
  work.command('show <workId>')
    .description('print the Work record (events and state) as JSON')
    .action((workId: string) => {
      select(async () => {
        const record = await host.work().get(workId)
        if (!record) throw new Error(`no Work ${workId}`)
        io.out(`${JSON.stringify(record, null, 2)}\n`)
        return 0
      })
    })
  work.command('list')
    .description('list Work: id, status, pinned spec')
    .action(() => {
      select(async () => {
        for (const work of await host.work().list()) io.out(`${work.id}  ${work.status.padEnd(9)}  ${work.specId}\n`)
        return 0
      })
    })
  work.command('report <workId>')
    .description('duration, attempts, operator touches and usage of a Work, from its events; for a Work of a Goal also its spend')
    .action((workId: string) => {
      select(async () => {
        io.out(`${JSON.stringify(await host.work().report(workId), null, 2)}\n`)
        return 0
      })
    })
  work.command('replay <workId>')
    .description('fold the recorded events again and compare with the stored state; runs nothing')
    .action((workId: string) => {
      select(async () => {
        const replayed = await host.work().replay(workId)
        io.out(`${JSON.stringify(replayed, null, 2)}\n`)
        return replayed.matches ? 0 : 1
      })
    })
  return program
}

/** The exit code of a followed Work; leaving it running in the Host is not a failure. */
const exitOf = (followed: Followed): number => (followed === 'detached' ? 0 : exitCode(followed.state.status))

/** succeeded 0, failed 1, held for the operator 3, not terminal 4, cancelled 5. */
export function exitCode(status: string): number {
  return { succeeded: 0, failed: 1, held: 3, cancelled: 5 }[status] ?? 4
}
