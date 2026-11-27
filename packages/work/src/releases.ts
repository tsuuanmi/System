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

/**
 * ms-4: who made a release. A release is a caller's, under the delegation of PLAN ("Release delegated", 2026-11-26),
 * when its merge commit message carries the line `Released-By: caller` (the marker a caller puts in the pull request
 * body), or when its pull request is one of `CALLER_RELEASE_PRS`: the releases made before the marker existed.
 * The merge commit's author cannot tell them apart (GitHub records the Operator's account for every merge of the pull request).
 */
const CALLER_RELEASE_MARKER = /^Released-By:\s*caller\s*$/im
const CALLER_RELEASE_PRS: ReadonlySet<number> = new Set([466, 469, 471, 478, 490])

/** Whether a release merge commit message (subject and body) is a caller's release. */
export function isCallerRelease(message: string): boolean {
  const pr = /^Merge pull request #(\d+) /.exec(message)
  return CALLER_RELEASE_MARKER.test(message) || (pr !== null && CALLER_RELEASE_PRS.has(Number(pr[1])))
}

/** relgate-1: what a caller's release may not touch (PLAN "Release delegated", 2026-11-27): those take effect only at a release. */
const NOT_DELEGATED = /^(packages\/(verifiers|effects)\/src\/|workflows\/[^/]+\.yaml$)/

/** The paths of a release's changed files that a caller's release may not touch; none for the Operator's release. */
export function releaseViolationPaths(files: readonly string[], byCaller: boolean): string[] {
  return byCaller ? files.filter((f) => NOT_DELEGATED.test(f)) : []
}

/** A caller's release that touched what is not delegated: the merge commit, the paths, the merge time. */
interface ReleaseViolation { merge: string; paths: string[]; at: string }

/** Release times split by who made them (`violations`: filled by `releasesBy` from git). */
interface ReleasesBy { operator: string[]; caller: string[]; violations: ReleaseViolation[] }

/** The release times in the output of `git log --merges --first-parent --format='%cI%x1f%P%x1f%B%x1e'`, split by `isCallerRelease`. */
export function releasesByMaker(log: string, devFirstParent: ReadonlySet<string>): Omit<ReleasesBy, 'violations'> {
  const releases = releaseMerges(log, devFirstParent)
  return { operator: releases.filter((r) => !r.caller).map((r) => r.at), caller: releases.filter((r) => r.caller).map((r) => r.at) }
}

/** The releases of a log (`%cI%x1f%P%x1f%B%x1f%H%x1e`; `%H` may be missing): time, whether a caller's, first parent and merge commit. */
function releaseMerges(log: string, devFirstParent: ReadonlySet<string>): { at: string; caller: boolean; first: string; merge: string }[] {
  const out = []
  for (const entry of log.split('\x1e')) {
    const [time, parents, message, merge] = entry.trim().split('\x1f')
    const [first, second] = parents?.split(/\s+/) ?? []
    if (time && first && second && devFirstParent.has(second)) out.push({ at: new Date(time).toISOString(), caller: isCallerRelease(message ?? ''), first, merge: merge?.trim() ?? '' })
  }
  return out
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
  const by = await releasesBy(repository)
  return [...by.operator, ...by.caller].sort()
}

/** `releasesOf` split by who made each release (ms-4). */
export async function releasesBy(repository: string): Promise<ReleasesBy> {
  try {
    const main = await firstRef(repository, ['refs/remotes/origin/main', 'refs/heads/main'])
    const dev = await firstRef(repository, ['refs/remotes/origin/dev', 'refs/heads/dev'])
    if (!main || !dev) return { operator: [], caller: [], violations: [] }
    const devCommits = new Set((await git(repository, ['rev-list', '--first-parent', dev])).split('\n').map((l) => l.trim()).filter(Boolean))
    const releases = releaseMerges(await git(repository, ['log', '--merges', '--first-parent', '--format=%cI%x1f%P%x1f%B%x1f%H%x1e', main]), devCommits)
    const violations: ReleaseViolation[] = []
    for (const r of releases.filter((x) => x.caller)) {
      const paths = releaseViolationPaths((await git(repository, ['diff', '--name-only', r.first, r.merge])).split('\n').filter(Boolean), true)
      if (paths.length) violations.push({ merge: r.merge, paths, at: r.at })
    }
    return { operator: releases.filter((r) => !r.caller).map((r) => r.at), caller: releases.filter((r) => r.caller).map((r) => r.at), violations }
  } catch { return { operator: [], caller: [], violations: [] } }
}
