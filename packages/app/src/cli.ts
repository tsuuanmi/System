/**
 * The `system` command line. Each action returns an exit code; the plugin
 * runs it once the host has started and then asks the launcher to exit.
 */
import { Command } from 'commander'
import { formatReport, runDoctor, type DoctorHost } from './doctor.ts'

export interface CliIo {
  out(text: string): void
}

/** A command the program selected, run after startup. */
export type Run = () => Promise<number>

/**
 * Build the program. `select` receives the chosen command's runner; commander
 * only parses, so nothing touches the host before startup completes.
 */
export function buildProgram(host: DoctorHost, io: CliIo, select: (run: Run) => void): Command {
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
