/**
 * Releases (Item ms-2): a release is a merge of `dev` into `main`, seen in the repository, not recorded by System:
 * a merge commit on the first parent of `main` whose second parent is on the first-parent history of `dev`
 * (pull requests from other branches merged into `main` are not releases).
 */
import { git } from './git.ts'

/**
 * The merge times (ISO, UTC) in the output of `git log --merges --first-parent --format='%cI %P'` whose second parent
 * is in `devFirstParent` (the commits of `git rev-list --first-parent <dev>`).
 */
export function releaseTimes(log: string, devFirstParent: ReadonlySet<string>): string[] {
  const times: string[] = []
  for (const line of log.split('\n')) {
    const [time, , second] = line.trim().split(/\s+/)
    if (time && second && devFirstParent.has(second)) times.push(new Date(time).toISOString())
  }
  return times
}

/** The first of `refs` that exists in the repository, else undefined. */
async function firstRef(repository: string, refs: string[]): Promise<string | undefined> {
  for (const ref of refs) {
    try { await git(repository, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return ref } catch { /* try the next */ }
  }
  return undefined
}

/**
 * The release times of one repository: merges into `origin/main` when it has one (the released tip), else `main`,
 * of `origin/dev` when it has one, else `dev`; none when it has no main or no dev, or is not a repository.
 */
export async function releasesOf(repository: string): Promise<string[]> {
  try {
    const main = await firstRef(repository, ['refs/remotes/origin/main', 'refs/heads/main'])
    const dev = await firstRef(repository, ['refs/remotes/origin/dev', 'refs/heads/dev'])
    if (!main || !dev) return []
    const devCommits = new Set((await git(repository, ['rev-list', '--first-parent', dev])).split('\n').map((l) => l.trim()).filter(Boolean))
    return releaseTimes(await git(repository, ['log', '--merges', '--first-parent', '--format=%cI %P', main]), devCommits)
  } catch { return [] }
}
