/**
 * The `system` command line. Each action returns an exit code; the plugin
 * runs it once the host has started and then asks the launcher to exit.
 */
import { readFileSync } from 'node:fs'
import { Command } from 'commander'
import type { Envelope, ReadResult } from '@system/artifacts'
import type { WorkRecord, WorkState } from '@system/work'
import { formatReport, runDoctor, type DoctorHost } from './doctor.ts'

export interface CliIo {
  out(text: string): void
  write(data: Uint8Array): void
  /** A secret from the terminal without echo, or all of piped stdin. */
  readSecret(prompt: string): Promise<string>
}

/** The credential operations the CLI offers; values go in, never out. */
export interface CredentialCommands {
  set(name: string, value: string): Promise<void>
  describe(name: string): Promise<{ configured: boolean; source?: string }>
}

/** The Artifact operations the CLI offers, resolved against the running host. */
export interface ArtifactCommands {
  putFile(path: string, mediaType: string, classification: string): Promise<Envelope>
  get(id: string): ReadResult
  readBytes(id: string): Promise<Uint8Array>
}

/** The Work operations the CLI offers. */
export interface WorkCommands {
  admitFile(path: string, input: string | undefined): Promise<WorkRecord>
  admitTask(capabilities: string[], input: string | undefined): Promise<WorkRecord>
  run(workId: string): Promise<WorkRecord>
  get(workId: string): WorkRecord | undefined
  list(): WorkRecord[]
  replay(workId: string): { state: WorkState; matches: boolean }
  cancel(workId: string, reason: string): Promise<'requested' | WorkRecord>
  retry(workId: string, worker: string | undefined, reason: string): Promise<WorkRecord>
  /** Whether another live host process holds the Work. */
  runningElsewhere(workId: string): boolean
  newTask(instructions: string, repository: string | undefined, ref: string | undefined): Promise<{ task: string; base?: string }>
}

export interface WorkersView {
  registered: string[]
  accounts: { ref: string; available: boolean; reason: string; version?: string }[]
}

export interface AppHost extends DoctorHost {
  artifacts(): ArtifactCommands
  work(): WorkCommands
  credentials(): CredentialCommands
  workers(): WorkersView
}

/** A command the program selected, run after startup. */
export type Run = () => Promise<number>

/**
 * Build the program. `select` receives the chosen command's runner; commander
 * only parses, so nothing touches the host before startup completes.
 */
export function buildProgram(host: AppHost, io: CliIo, select: (run: Run) => void): Command {
  const program = new Command('system')
    .description('System: a durable work control plane for replaceable AI Workers')
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
        const read = host.artifacts().get(id)
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
  program.command('workers')
    .description('registered Workers, and each configured agent account with why it is or is not available')
    .action(() => {
      select(async () => {
        const { registered, accounts } = host.workers()
        io.out(`registered: ${registered.join(', ') || 'none'}\n`)
        for (const a of accounts) {
          io.out(`${a.ref.padEnd(22)} ${a.available ? 'available  ' : 'unavailable'} ${a.version ?? ''} ${a.available ? '' : `- ${a.reason}`}\n`)
        }
        return 0
      })
    })
  const task = program.command('task').description('task inputs for Work')
  task.command('new')
    .description('store a task@1 Artifact (and, with --repo, the exact base commit) and print its ID')
    .option('--text <instructions>', 'the instructions')
    .option('--file <path>', 'read the instructions from a file')
    .option('--repo <path>', 'a git repository the task starts from')
    .option('--ref <ref>', 'the commit or branch in --repo', 'HEAD')
    .action((options: { text?: string; file?: string; repo?: string; ref: string }) => {
      select(async () => {
        if (Boolean(options.text) === Boolean(options.file)) throw new Error('give exactly one of --text and --file')
        const instructions = options.text ?? readFileSync(options.file!, 'utf8')
        const created = await host.work().newTask(instructions, options.repo, options.repo ? options.ref : undefined)
        if (created.base) io.out(`base ${created.base}\n`)
        io.out(`${created.task}\n`)
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
    .option('--no-run', 'admit only')
    .action((options: { workflow?: string; capability?: string[]; input?: string; run: boolean }) => {
      select(async () => {
        if (Boolean(options.workflow) === Boolean(options.capability)) throw new Error('give exactly one of --workflow and --capability')
        const commands = host.work()
        const admitted = options.workflow
          ? await commands.admitFile(options.workflow, options.input)
          : await commands.admitTask(options.capability!, options.input)
        io.out(`${admitted.id}\n`)
        if (!options.run) return 0
        return exitCode((await commands.run(admitted.id)).state.status)
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
        // This process caches records, so it waits for the host to release the Work instead.
        while (host.work().runningElsewhere(workId)) await new Promise((resolve) => setTimeout(resolve, 250))
        io.out(`${workId}: the running host has stopped; see system work show\n`)
        return 0
      })
    })
  work.command('retry <workId>')
    .description('take over a failed or cancelled Worker step with a new attempt from the recorded Artifacts')
    .option('--worker <ref>', 'only this Worker may take it over (see system workers)')
    .option('--reason <text>', 'why', 'retried by the operator')
    .action((workId: string, options: { worker?: string; reason: string }) => {
      select(async () => exitCode((await host.work().retry(workId, options.worker, options.reason)).state.status))
    })
  work.command('run <workId>')
    .description('advance admitted or interrupted Work until it is terminal')
    .action((workId: string) => {
      select(async () => exitCode((await host.work().run(workId)).state.status))
    })
  work.command('show <workId>')
    .description('print the Work record (events and state) as JSON')
    .action((workId: string) => {
      select(async () => {
        const record = host.work().get(workId)
        if (!record) throw new Error(`no Work ${workId}`)
        io.out(`${JSON.stringify(record, null, 2)}\n`)
        return 0
      })
    })
  work.command('list')
    .description('list Work: id, status, pinned spec')
    .action(() => {
      select(async () => {
        for (const record of host.work().list()) io.out(`${record.id}  ${record.state.status.padEnd(9)}  ${record.state.specId}\n`)
        return 0
      })
    })
  work.command('replay <workId>')
    .description('fold the recorded events again and compare with the stored state; runs nothing')
    .action((workId: string) => {
      select(async () => {
        const replayed = host.work().replay(workId)
        io.out(`${JSON.stringify(replayed, null, 2)}\n`)
        return replayed.matches ? 0 : 1
      })
    })
  return program
}

/** succeeded 0, failed 1, held for the operator 3, not terminal 4, cancelled 5. */
export function exitCode(status: string): number {
  return { succeeded: 0, failed: 1, held: 3, cancelled: 5 }[status] ?? 4
}
