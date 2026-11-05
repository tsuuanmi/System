/**
 * The `system` command line. Each action returns an exit code; the plugin
 * runs it once the host has started and then asks the launcher to exit.
 */
import { Command } from 'commander'
import type { Envelope, ReadResult } from '@system/artifacts'
import { formatReport, runDoctor, type DoctorHost } from './doctor.ts'

export interface CliIo {
  out(text: string): void
  write(data: Uint8Array): void
}

/** The Artifact operations the CLI offers, resolved against the running host. */
export interface ArtifactCommands {
  putFile(path: string, mediaType: string, classification: string): Promise<Envelope>
  get(id: string): ReadResult
  readBytes(id: string): Promise<Uint8Array>
}

export interface AppHost extends DoctorHost {
  artifacts(): ArtifactCommands
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
  const work = program.command('work').description('submit, inspect and cancel Work (from milestone M2)')
  work.action(() => {
    select(async () => {
      io.out(work.helpInformation())
      io.out('no work commands yet: they arrive with milestone M2 (PLAN.md)\n')
      return 2
    })
  })
  return program
}
