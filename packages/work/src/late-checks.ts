/**
 * The checks a Work's checks step skips (ct-2, ADR-0014): those of `.system/checks.yaml` on `dev` whose `on:` lacks `pull_request`.
 * `work report` counts a failed release verdict on one of them as a late-caught defect.
 */
import { parse } from 'yaml'
import { git } from '@system/git'

export async function lateChecks(repositories: readonly string[]): Promise<Set<string>> {
  const names = new Set<string>()
  for (const repository of repositories) {
    for (const ref of ['refs/remotes/origin/dev', 'refs/heads/dev']) {
      try {
        const doc = parse(await git(repository, ['show', `${ref}:.system/checks.yaml`])) as { checks?: { name?: unknown; on?: unknown }[] }
        for (const c of doc.checks ?? []) if (typeof c.name === 'string' && Array.isArray(c.on) && !c.on.includes('pull_request')) names.add(c.name)
        break
      } catch { /* try the next ref */ }
    }
  }
  return names
}
