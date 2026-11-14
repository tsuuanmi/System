/**
 * `system bootstrap check --repo <path>` (Item bs-2): whether a repository is ready for System, read from git only.
 * It needs no Host and writes nothing, not even to the working tree; the one thing it runs, `tools/docs.py check`,
 * runs in a temporary worktree of dev.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Command } from 'commander'
import { addWorktree, git, parseStatus, removeWorktree } from '@system/work'
// By path, as client.ts imports the Host: declaring @system/verifiers here would change the lockfile.
import { CHECKS_FILE, parseChecksFile } from '../../verifiers/lib/checks.js'

export interface BootstrapResult {
  name: string
  /** Absent when the item passes. */
  problem?: string
}

const GITHUB = /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?|[^@/\s:]+@)github\.com[:/]/i
const DOCS_MS = 120_000
/** A glob that reaches only documentation: `*.md` (any depth) and `docs/**`. */
const DOCS_ONLY = /^(?:docs\/.*|(?:\*\*\/)?[^/]*\.md)$/

const refExists = (top: string, ref: string): Promise<boolean> => git(top, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).then(() => true, () => false)
const message = (error: unknown): string => (error as Error).message

/** Run every check on the repository that contains `path`, in the order of the items. */
export async function bootstrapCheck(path: string): Promise<BootstrapResult[]> {
  const top = realpathSync((await git(path, ['rev-parse', '--show-toplevel'])).trim())
  const results: BootstrapResult[] = []
  const item = async (name: string, check: () => Promise<string | undefined>): Promise<string | undefined> => {
    const problem = await check().catch((error: unknown) => message(error))
    results.push(problem === undefined ? { name } : { name, problem })
    return problem
  }

  await item('origin', async () => {
    const url = (await git(top, ['remote', 'get-url', 'origin']).catch(() => '')).trim()
    if (!url) return 'the repository has no remote named origin'
    return GITHUB.test(url) ? undefined : `origin is ${url}, which is not on github.com`
  })

  // Read as `status` reads: origin/dev, else dev.
  const ref = (await refExists(top, 'refs/remotes/origin/dev')) ? 'refs/remotes/origin/dev' : (await refExists(top, 'refs/heads/dev')) ? 'refs/heads/dev' : undefined
  await item('dev', async () => (ref ? undefined : 'no dev branch and no origin/dev'))
  const show = async (file: string): Promise<string | undefined> => (ref ? git(top, ['show', `${ref}:${file}`]).catch(() => undefined) : undefined)
  const missing = (file: string): string => (ref ? `no ${file} on ${ref.replace(/^refs\/(heads|remotes)\//, '')}` : 'no dev branch to read it from')

  let checks: { name: string; paths?: string[] }[] | undefined
  await item('checks', async () => {
    const text = await show(CHECKS_FILE)
    if (text === undefined) return missing(CHECKS_FILE)
    const parsed = parseChecksFile(text)
    if ('problem' in parsed) return `${CHECKS_FILE} is invalid: ${parsed.problem}`
    checks = parsed.checks
    return undefined
  })

  await item('guard', async () => {
    if (!checks) return `no valid ${CHECKS_FILE} to judge`
    return checks.some((c) => !c.paths || c.paths.some((glob) => !DOCS_ONLY.test(glob)))
      ? undefined
      : 'every check is limited to documentation paths: a code change would pass with no check run'
  })

  await item('status', async () => {
    const text = await show('STATUS.md')
    if (text === undefined) return missing('STATUS.md')
    try {
      parseStatus(text, { strict: true })
      return undefined
    } catch (error) {
      return message(error)
    }
  })

  const hasDocs = ref ? await git(top, ['cat-file', '-e', `${ref}:tools/docs.py`]).then(() => true, () => false) : false
  await item('docs', async () => (hasDocs ? docsCheck(top, ref!) : undefined))
  return results
}

/** `python3 tools/docs.py check` in a temporary worktree of `ref`; the problem is the end of its output. */
async function docsCheck(top: string, ref: string): Promise<string | undefined> {
  const scratch = mkdtempSync(join(tmpdir(), 'system-bootstrap-'))
  const worktree = join(scratch, 'dev')
  try {
    await addWorktree(top, worktree, (await git(top, ['rev-parse', `${ref}^{commit}`])).trim())
    await promisify(execFile)('python3', ['tools/docs.py', 'check'], {
      cwd: worktree, timeout: DOCS_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/' },
    })
    return undefined
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean }
    if (e.code === 'ENOENT') return 'python3 is not installed'
    if (e.killed) return `python3 tools/docs.py check took longer than ${DOCS_MS / 1000} s`
    const tail = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim().split('\n').slice(-8).join(' | ')
    return `python3 tools/docs.py check failed${tail ? `: ${tail}` : `: ${e.message}`}`
  } finally {
    await removeWorktree(top, worktree)
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** One line per item: `name: ok` or `name: fail: reason`. */
export function formatBootstrap(results: BootstrapResult[]): string {
  return results.map((r) => `${r.name}: ${r.problem === undefined ? 'ok' : `fail: ${r.problem.replace(/\s*\n\s*/g, ' ')}`}\n`).join('')
}

/** `system bootstrap ...`: the exit code is 1 when any item fails. */
export async function bootstrapMain(args: string[], out: (text: string) => void): Promise<number> {
  let run: (() => Promise<number>) | undefined
  const program = new Command('system').exitOverride()
  program.command('bootstrap').description('check that a repository is ready for System')
    .command('check')
    .description('read-only: origin on github.com, dev branch, checks file, false-green guard, STATUS.md, docs check; one line per item, non-zero exit if any fails')
    .option('--repo <path>', 'a git repository', '.')
    .action((options: { repo: string }) => {
      run = async () => {
        const results = await bootstrapCheck(options.repo)
        out(formatBootstrap(results))
        return results.every((r) => r.problem === undefined) ? 0 : 1
      }
    })
  program.parse(args, { from: 'user' })
  return run ? run() : 0
}
