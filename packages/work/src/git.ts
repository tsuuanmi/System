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
import { WorkError } from './errors.ts'
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

/**
 * The settings by which this process reaches a remote. `git()` runs with a minimal environment, which dropped them: a fetch
 * then went to the real host where the caller (the upgrade rehearsal, a user with `GIT_SSH_COMMAND` or an agent) meant another,
 * and wrote a diverged `origin/dev` that the install's unforced `git fetch origin dev:refs/remotes/origin/dev` refused (b684f18).
 */
const REMOTE_ENV = ['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'SSH_AUTH_SOCK']
const remoteEnv = (): Record<string, string> => Object.fromEntries(REMOTE_ENV.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]!]])))

/** The longest a fetch of `origin <branch>` may take before the caller goes on without it. */
const FETCH_MS = 20_000

/**
 * Fetch `origin <branch>` into `refs/remotes/origin/<branch>` (explicitly, so a repository whose origin refspec
 * names other branches is updated too). `skipped` when the repository has no `origin`; never throws.
 */
export async function fetchOrigin(repository: string, branch: string, timeoutMs = FETCH_MS): Promise<{ state: 'fetched' | 'skipped' } | { state: 'failed'; error: string }> {
  const hasOrigin = await git(repository, ['remote', 'get-url', 'origin']).then(() => true, () => false)
  if (!hasOrigin) return { state: 'skipped' }
  try {
    await git(repository, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], remoteEnv(), timeoutMs)
    return { state: 'fetched' }
  } catch (error) {
    return { state: 'failed', error: (error as Error).message.replace(/\s+/g, ' ').slice(0, 300) }
  }
}

/**
 * A `ref` that names a local branch with an `origin/<branch>` counterpart is checked against the origin: fetch it
 * (bounded; a failure is no refusal and comes back as the note), and refuse when the origin has commits the local
 * branch lacks, naming both commits and `origin/<branch>`. Any other ref (`origin/dev`, a commit, `HEAD`) is left alone.
 * Returns a note for the caller when the fetch failed.
 */
export async function freshBranch(repository: string, ref: string | undefined, timeoutMs = FETCH_MS): Promise<string | undefined> {
  if (!ref) return undefined
  const top = (await git(repository, ['rev-parse', '--show-toplevel'])).trim()
  const resolve = (full: string) => git(top, ['rev-parse', '--verify', '--quiet', `${full}^{commit}`]).then((out) => out.trim(), () => undefined)
  if (!(await resolve(`refs/heads/${ref}`))) return undefined
  const fetched = await fetchOrigin(top, ref, timeoutMs)
  if (fetched.state === 'skipped') return undefined
  const local = await resolve(`refs/heads/${ref}`)
  const remote = await resolve(`refs/remotes/origin/${ref}`)
  if (local && remote && local !== remote && !(await git(top, ['merge-base', '--is-ancestor', remote, local]).then(() => true, () => false))) {
    throw new WorkError(`${ref} (${local.slice(0, 12)}) lacks commits of origin/${ref} (${remote.slice(0, 12)})${fetched.state === 'failed' ? ' as last fetched' : ''}; use origin/${ref} as the ref, or update ${ref}`)
  }
  return fetched.state === 'failed' ? `fetch of origin ${ref} failed (${fetched.error}); ${ref} was taken as the local branch has it` : undefined
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

/** Keep a commit reachable so garbage collection never drops an Artifact's subject. */
export async function pin(repository: string, commit: string): Promise<void> {
  await git(repository, ['update-ref', `refs/system/artifacts/${commit}`, commit])
}

export async function removeWorktree(repository: string, path: string): Promise<void> {
  await git(repository, ['worktree', 'remove', '--force', path]).catch(() => undefined)
  rmSync(path, { recursive: true, force: true })
  await git(repository, ['worktree', 'prune']).catch(() => undefined)
}
