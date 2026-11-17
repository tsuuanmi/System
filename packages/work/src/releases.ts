/**
 * Releases (Item ms-2): a release is a merge of `dev` into `main`, seen in the repository, not recorded by System:
 * the merge commits on the first parent of `main`.
 */
import { git } from './git.ts'

/** The merge times (ISO, UTC) in the output of `git log --merges --first-parent --format=%cI`. */
export function releaseTimes(log: string): string[] {
  return log.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => new Date(l).toISOString())
}

/** The release times of one repository: `origin/main` when it has one (the released tip), else `main`; none when it has neither. */
export async function releasesOf(repository: string): Promise<string[]> {
  for (const ref of ['refs/remotes/origin/main', 'refs/heads/main']) {
    try {
      return releaseTimes(await git(repository, ['log', '--merges', '--first-parent', '--format=%cI', ref]))
    } catch { /* no such ref or not a repository: try the next */ }
  }
  return []
}
