/**
 * The git operations that need System's kinds and errors: snapshot a commit, pin it, and the
 * fetch checks of a branch. The git call itself, worktrees and capture are `@system/git`.
 */
import { realpathSync } from 'node:fs'
import { git } from '@system/git'
import { WorkError } from './errors.ts'
import type { GitTreeContent } from './kinds.ts'

const SHA = /^[0-9a-f]{40}$/

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
 * branch lacks, naming both commits and `origin/<branch>`. An explicit `origin/<branch>` is fetched too (never refused; the note on failure). A commit or `HEAD` is left alone.
 * Returns a note for the caller when the fetch failed.
 */
export async function freshBranch(repository: string, ref: string | undefined, timeoutMs = FETCH_MS): Promise<string | undefined> {
  if (!ref) return undefined
  const explicit = /^origin\/(.+)$/.exec(ref)
  if (explicit) {
    const fetched = await fetchOrigin(repository, explicit[1]!, timeoutMs)
    return fetched.state === 'failed' ? `fetch of origin ${explicit[1]} failed (${fetched.error}); ${ref} was taken as last fetched` : undefined
  }
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

/** Keep a commit reachable so garbage collection never drops an Artifact's subject. */
export async function pin(repository: string, commit: string): Promise<void> {
  await git(repository, ['update-ref', `refs/system/artifacts/${commit}`, commit])
}
