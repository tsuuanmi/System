/**
 * The git operations System needs: snapshot a commit, check it out into a
 * detached worktree, capture a worktree as an exact commit, pin it, and
 * remove it. Capture is the technique of System 1's worktree recorder
 * (tsuuanmi/system f199a27, packages/plugins/agent-workers/src/worktrees.ts);
 * its worktree ownership and landing are not used.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { GitTreeContent } from './kinds.ts'

const run = promisify(execFile)
const GIT_MS = 60_000
/** Never run repository hooks or sign; never prompt. */
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false']
const IDENTITY = {
  GIT_AUTHOR_NAME: 'System', GIT_AUTHOR_EMAIL: 'system@localhost',
  GIT_COMMITTER_NAME: 'System', GIT_COMMITTER_EMAIL: 'system@localhost',
  GIT_TERMINAL_PROMPT: '0',
}
const SHA = /^[0-9a-f]{40}$/

export async function git(dir: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', dir, ...SAFE, ...args], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', ...IDENTITY, ...env },
      timeout: GIT_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean }
    const said = e.code === 'ENOENT' ? 'git is not installed' : e.killed ? `it took longer than ${GIT_MS / 1000} s` : (e.stderr ?? e.message).trim()
    throw new Error(`git ${args[0]} in ${dir} failed: ${said}`)
  }
}

/** Resolve `ref` in the repository that contains `path`. */
export async function snapshot(path: string, ref = 'HEAD'): Promise<GitTreeContent> {
  const repository = realpathSync((await git(path, ['rev-parse', '--show-toplevel'])).trim())
  const commit = (await git(repository, ['rev-parse', '--verify', `${ref}^{commit}`])).trim()
  const tree = (await git(repository, ['rev-parse', `${commit}^{tree}`])).trim()
  if (!SHA.test(commit) || !SHA.test(tree)) throw new Error(`could not resolve ${ref} in ${repository}`)
  return { repository, commit, tree }
}

/** Check `commit` out, detached, into a new worktree at `path`. */
export async function addWorktree(repository: string, path: string, commit: string): Promise<void> {
  await git(repository, ['worktree', 'add', '--detach', '--quiet', path, commit])
}

/**
 * Capture everything in the worktree, tracked or not (ignored files excepted),
 * as one commit on `base`; an unchanged worktree is `base` itself.
 */
export async function captureTree(repository: string, worktree: string, base: string, message: string): Promise<GitTreeContent> {
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

/**
 * `change` with every file that `from` (the tests step's change) added, modified or deleted put back as `from` left
 * it, as one commit on `change`'s parent (`from`'s commit when it has none); `change` itself when nothing differs.
 */
export async function restoreFiles(repository: string, change: GitTreeContent, from: GitTreeContent, message: string): Promise<GitTreeContent> {
  if (!from.parent) throw new Error(`the tests step's change ${from.commit} names no parent: what it wrote is unknown`)
  const names = (await git(repository, ['diff', '--name-only', '--no-renames', '-z', from.parent, from.commit])).split('\0').filter(Boolean)
  const scratch = mkdtempSync(join(tmpdir(), 'system-index-'))
  try {
    const index = { GIT_INDEX_FILE: join(scratch, 'index') }
    await git(repository, ['read-tree', change.commit], index)
    for (const name of names) {
      const listed = (await git(repository, ['ls-tree', '-z', from.commit, '--', name])).split('\0')[0]!
      const match = /^(\d+) \w+ ([0-9a-f]{40})\t/.exec(listed)
      if (match) await git(repository, ['update-index', '--add', '--cacheinfo', `${match[1]},${match[2]},${name}`], index)
      else await git(repository, ['update-index', '--force-remove', '--', name], index)
    }
    const tree = (await git(repository, ['write-tree'], index)).trim()
    if (tree === change.tree) return change
    const parent = change.parent ?? from.commit
    const commit = (await git(repository, ['commit-tree', tree, '-p', parent, '-m', message], index)).trim()
    return { repository, commit, tree, ...(change.parent ? { parent: change.parent } : { parent }) }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Keep a commit reachable so garbage collection never drops an Artifact's subject. */
export async function pin(repository: string, commit: string): Promise<void> {
  await git(repository, ['update-ref', `refs/system/artifacts/${commit}`, commit])
}

export async function removeWorktree(repository: string, path: string): Promise<void> {
  await git(repository, ['worktree', 'remove', '--force', path]).catch(() => undefined)
  rmSync(path, { recursive: true, force: true })
  await git(repository, ['worktree', 'prune']).catch(() => undefined)
}
