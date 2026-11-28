/**
 * The active core's lines (ir-9, ADR-0015): the .ts lines of packages/work/src and packages/artifacts/src on `dev`, counted from git.
 * A trend `work report --since` shows at the range's start and end, never a gate.
 */
import { git } from '@system/git'
import type { Unknown } from './measures.ts'

export type CoreLines = { start: number | Unknown; end: number | Unknown } | Unknown

const CORE = ['packages/work/src/*.ts', 'packages/artifacts/src/*.ts']

async function firstRef(repository: string, refs: string[]): Promise<string | undefined> {
  for (const ref of refs) {
    try { await git(repository, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return ref } catch { /* try the next */ }
  }
  return undefined
}

/** The core's lines at the last commit of `dev` before `before` (now when omitted); unknown when there is none. */
async function linesAt(repository: string, dev: string, before?: string): Promise<number | Unknown> {
  try {
    const commit = (await git(repository, ['rev-list', '-1', ...(before === undefined ? [] : [`--before=${before}`]), dev])).trim()
    if (!commit) return 'unknown'
    let out = ''
    try { out = await git(repository, ['grep', '-c', '', commit, '--', ...CORE]) } catch { return 0 } // git grep exits 1 when nothing matches
    return out.split('\n').reduce((sum, line) => sum + (Number(line.slice(line.lastIndexOf(':') + 1)) || 0), 0)
  } catch { return 'unknown' }
}

/** The first repository that has a `dev` and core files at either end counts (a repository without them is not System's); `unknown` when git is unavailable or none does. */
export async function activeCoreLines(repositories: readonly string[], since: string, until?: string): Promise<CoreLines> {
  for (const repository of repositories) {
    const dev = await firstRef(repository, ['refs/remotes/origin/dev', 'refs/heads/dev'])
    if (!dev) continue
    const lines = { start: await linesAt(repository, dev, since), end: await linesAt(repository, dev, until) }
    if (lines.start || lines.end) return lines.start === 'unknown' && lines.end === 'unknown' ? 'unknown' : lines
  }
  return 'unknown'
}
