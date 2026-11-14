/**
 * tr-1: the existing tests a change modified or deleted, for disclosure only.
 *
 * System computes the list from git, so a Worker cannot leave a file out: the
 * files that exist at the change's base, are tests, and are modified or deleted
 * (a rename counts as a delete, a new file is not listed). The Worker only
 * supplies a reason per file, in its final message; the list never holds,
 * fails or blocks a Work.
 */
import { git } from './git.ts'

export interface ChangedTest {
  path: string
  change: 'modified' | 'deleted'
}
export interface ChangedTestWithReason extends ChangedTest {
  reason: string
}

export const NO_REASON = 'no reason given'
const MAX_REASON = 300

/** Under `tests/`, `packages/<name>/tests/` or `test-support/`, or named `*.test.*`, `*_test.*` or `test_*`. */
export function isTestPath(path: string): boolean {
  if (/^(tests|test-support)\//.test(path) || /^packages\/[^/]+\/tests\//.test(path)) return true
  const name = path.slice(path.lastIndexOf('/') + 1)
  return /^.+\.test\..+$/.test(name) || /^.+_test\..+$/.test(name) || /^test_.+$/.test(name)
}

/** The tests present at `base` that `commit` modified or deleted, in path order. */
export async function changedTests(repository: string, base: string, commit: string): Promise<ChangedTest[]> {
  if (base === commit) return []
  const out = await git(repository, ['diff', '--name-status', '--no-renames', '-z', '--diff-filter=MTD', base, commit])
  const fields = out.split('\0')
  const list: ChangedTest[] = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [status, path] = [fields[i]!, fields[i + 1]!]
    if (isTestPath(path)) list.push({ path, change: status === 'D' ? 'deleted' : 'modified' })
  }
  return list.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** The Worker's one line per file: `<path>: <reason>` (a list marker, backticks or a dash for the colon are accepted). */
function reasonFor(path: string, message: string): string | undefined {
  for (const line of message.split('\n')) {
    let from = line.indexOf(path)
    while (from >= 0) {
      const rest = line.slice(from + path.length).match(/^[`*\s]*[:—–-]+\s*(.*)$/)
      const reason = rest?.[1]?.replace(/[`*\s]+$/, '').replace(/\s+/g, ' ').trim()
      if (reason) return reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON)}…` : reason
      from = line.indexOf(path, from + 1)
    }
  }
  return undefined
}

export function withReasons(files: readonly ChangedTest[], message: string | undefined): ChangedTestWithReason[] {
  return files.map((file) => ({ ...file, reason: (message && reasonFor(file.path, message)) || NO_REASON }))
}
