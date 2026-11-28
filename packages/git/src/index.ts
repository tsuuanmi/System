/**
 * The git operations System runs: one safe `git` call (no hooks, no signing, no prompt), a detached
 * worktree added and removed, and a worktree captured as an exact commit. Capture is the technique of
 * System 1's worktree recorder (tsuuanmi/system f199a27, packages/plugins/agent-workers/src/worktrees.ts);
 * its worktree ownership and landing are not used.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const GIT_MS = 60_000
/** Never run repository hooks or sign; never prompt. */
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false']
const IDENTITY = {
  GIT_AUTHOR_NAME: 'System', GIT_AUTHOR_EMAIL: 'system@localhost',
  GIT_COMMITTER_NAME: 'System', GIT_COMMITTER_EMAIL: 'system@localhost',
  GIT_TERMINAL_PROMPT: '0',
}

/** What a capture returns; `@system/work`'s `GitTreeContent` has this shape. */
export interface CapturedTree { repository: string; commit: string; tree: string; parent?: string }

export async function git(dir: string, args: string[], env: Record<string, string> = {}, timeoutMs = GIT_MS): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', dir, ...SAFE, ...args], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', ...IDENTITY, ...env },
      timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean }
    const said = e.code === 'ENOENT' ? 'git is not installed' : e.killed ? `it took longer than ${timeoutMs / 1000} s` : (e.stderr ?? e.message).trim()
    throw new Error(`git ${args[0]} in ${dir} failed: ${said}`)
  }
}

/** Check `commit` out, detached, into a new worktree at `path`. */
export async function addWorktree(repository: string, path: string, commit: string): Promise<void> {
  await git(repository, ['worktree', 'add', '--detach', '--quiet', path, commit])
}

/**
 * Capture everything in the worktree, tracked or not (ignored files excepted),
 * as one commit on `base`; an unchanged worktree is `base` itself.
 */
export async function captureTree(repository: string, worktree: string, base: string, message: string): Promise<CapturedTree> {
  const scratch = mkdtempSync(join(tmpdir(), 'system-index-'))
  try {
    const index = { GIT_INDEX_FILE: join(scratch, 'index') }
    const inside = (args: string[]) => git(worktree, args, index)
    await inside(['read-tree', base])
    await inside(['add', '--all', '--', '.'])
    const tree = (await inside(['write-tree'])).trim()
    const baseTree = (await git(repository, ['rev-parse', `${base}^{tree}`])).trim()
    if (tree === baseTree) return { repository, commit: base, tree, parent: base }
    const commit = (await inside(['commit-tree', tree, '-p', base, '-m', message])).trim()
    return { repository, commit, tree, parent: base }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export async function removeWorktree(repository: string, path: string): Promise<void> {
  await git(repository, ['worktree', 'remove', '--force', path]).catch(() => undefined)
  rmSync(path, { recursive: true, force: true })
  await git(repository, ['worktree', 'prune']).catch(() => undefined)
}
