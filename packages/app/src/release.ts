/**
 * `system release prepare <commit>` (ADR-0019 decisions 1 and 2): cut `release/<7 hex>` at a commit of `dev`, push it, and
 * write the release report as Markdown from records. It prepares; it never merges and never opens the pull request.
 */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { git } from '@system/git'
import { mergeCommitOf, releaseViolationPaths } from '@system/work/contract'
import type { HostClient } from './remote.ts'

const WAIVER = /^docs-unchanged:\s*\S/i

/** The first of `refs` that names a commit in the repository. */
async function firstRef(repository: string, refs: string[]): Promise<string | undefined> {
  for (const ref of refs) {
    try { await git(repository, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return ref } catch { /* next */ }
  }
  return undefined
}

/** The commit `current` (`$SYSTEM_CODE`, else `~/.system/current`) runs: the name of the release directory it links to. */
function runningCommit(): string | undefined {
  try { return basename(realpathSync(process.env.SYSTEM_CODE ?? join(homedir(), '.system', 'current'))) } catch { return undefined }
}

const lines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter(Boolean)

/** Create and push the release branch, and return the report. */
export async function prepareRelease(host: HostClient, repository: string, given: string): Promise<string> {
  if (!/^[0-9a-fA-F]{7,40}$/.test(given)) throw new Error('give the commit as 7 to 40 hex characters')
  const commit = lines(await git(repository, ['rev-parse', '--verify', `${given}^{commit}`]))[0]!
  const main = await firstRef(repository, ['refs/remotes/origin/main', 'refs/heads/main'])
  const dev = await firstRef(repository, ['refs/remotes/origin/dev', 'refs/heads/dev'])
  if (!main || !dev) throw new Error('the repository needs a main and a dev branch')
  if (!lines(await git(repository, ['rev-list', '--first-parent', dev])).includes(commit)) throw new Error(`${commit.slice(0, 12)} is not on dev's first-parent history`)
  const branch = `release/${commit.slice(0, 7)}`
  await git(repository, ['branch', '--force', branch, commit])
  await git(repository, ['push', 'origin', `${branch}:refs/heads/${branch}`])

  const inRange = new Set(lines(await git(repository, ['rev-list', `${main}..${commit}`])))
  const merged: { id: string; item?: string; commit: string; accounts: string[]; cost: string }[] = []
  for (const listed of await host.call('work.list', {})) {
    const record = await host.call('work.show', { workId: listed.id })
    if (!record) continue
    const at = mergeCommitOf(record)
    if (!at || !inRange.has(at)) continue
    const accounts = [...new Set(record.events.flatMap((e) => (e.type === 'dispatched' && e.executor === 'worker' ? [e.selected] : [])))]
    const usage = (await host.call('work.report', { workId: listed.id }) as { usage?: { costUsdEstimate?: number } }).usage
    merged.push({ id: listed.id, ...(listed.item ? { item: listed.item } : {}), commit: at, accounts, cost: usage?.costUsdEstimate === undefined ? 'unknown' : `$${usage.costUsdEstimate.toFixed(2)}` })
  }
  const items = new Set(merged.flatMap((m) => (m.item ? [m.item] : [])))

  const { defects, withdrawals } = await host.call('defect.list', {})
  const gone = new Set<string>([...defects.flatMap((d) => (d.supersedes ? [d.supersedes] : [])), ...withdrawals.map((w) => w.withdraws)])
  const escaped = defects.filter((d) => !gone.has(d.id) && ((d.item !== undefined && items.has(d.item)) || (d.commit !== undefined && merged.some((m) => m.commit.startsWith(d.commit!)))))

  const waiversAt = async (ref: string) => { try { return lines(await git(repository, ['show', `${ref}:.system/docs-waivers`])).filter((l) => WAIVER.test(l)) } catch { return [] } }
  const before = new Set(await waiversAt(main))
  const waivers = (await waiversAt(commit)).filter((l) => !before.has(l))

  const notDelegated = releaseViolationPaths(lines(await git(repository, ['diff', '--name-only', `${main}...${commit}`])), true)
  const running = runningCommit()

  const list = (rows: string[]) => (rows.length ? rows : ['None.'])
  return [
    `# Release ${commit.slice(0, 7)}`,
    '',
    `Branch \`${branch}\` at \`${commit}\`: ${inRange.size} commits not in \`${main.replace(/^refs\/(remotes|heads)\//, '')}\`.`,
    '',
    '## Items and Works merged',
    '',
    ...list(merged.map((m) => `- ${m.item ?? '(no Item)'}: ${m.id}, Account ${m.accounts.join(', ') || 'unknown'}, cost ${m.cost}`)),
    '',
    '## Escaped defects recorded for these Items',
    '',
    ...list(escaped.map((d) => `- ${d.item ?? d.commit}: ${d.reason} (${d.id})`)),
    '',
    '## Docs waivers of the range',
    '',
    ...list(waivers.map((l) => `- ${l}`)),
    '',
    '## Paths not delegated',
    '',
    '`packages/verifiers/src`, `packages/effects/src` and `workflows/*.yaml` take effect only at a release: a caller releases a range that touches them only for a commit the Operator approved (`system release approve`).',
    '',
    ...list(notDelegated.map((p) => `- ${p}`)),
    '',
    '## How to revert',
    '',
    running ? `\`system update --to ${running}\` (the commit the install runs now).` : 'The install runs no release now (`~/.system/current` is not set): there is nothing to revert to.',
    'A revert does not undo a record schema change (`git diff <commit>..<later> -- packages/work/src/record.ts packages/artifacts/src` shows it).',
    '',
  ].join('\n')
}
