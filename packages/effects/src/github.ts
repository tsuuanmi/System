/**
 * `git.publish` for GitHub (ADR-0004 decisions 10-11, ADR-0008): push the exact
 * verified commit to `system/<work>` on the subject repository's remote, and
 * open one draft pull request for that branch. It merges only with
 * `merge: true`, and only when the base branch is in `mergeInto`.
 *
 * - A pull request is the branch's only when it targets `base`; an open one aimed
 *   at another base makes apply `failed` (never merged, never retargeted).
 * - apply is idempotent per Work: a branch already at the commit is not
 *   pushed again, and an open pull request for the branch is reused.
 * - The branch moves only from a commit System published (pinned under
 *   `refs/system/artifacts/`), with a lease on the commit just read; any
 *   other commit there is refused.
 * - merge (PROP-0007 decision 6, the merge queue): one change at a time per
 *   base. A change that holds the base's tip goes in as it is; any other is
 *   merged with the tip (`git merge-tree`; a conflict fails, naming the files)
 *   and the merge commit is checked with the required checks' pinned criteria.
 *   The base then moves to exactly that commit with a lease on the tip it was
 *   checked on (bors' "not rocket science" rule); if the base moved meanwhile,
 *   the change is merged and checked again on the new tip. The pull request is
 *   opened ready, for the record; GitHub's merge endpoint is not used.
 * - reconcile only reads the remote: `applied` when the branch holds the commit
 *   and its pull request is open (and ready, if asked) or, with `merge`, when the
 *   base holds the change; `absent` otherwise; `unknown` when it cannot be read.
 * - The token reaches git through `GIT_CONFIG_*` environment variables, never
 *   its arguments, and the API through the Authorization header.
 */
import { execFile } from 'node:child_process'
import type { Artifacts } from '@system/artifacts'
import { GIT_TREE_KIND, git as runGit, pin, type EffectIntent, type EffectOutcome, type EffectPort, type GitTreeContent, type Reconciled } from '@system/work'

export interface PublishConfig {
  /** The git remote of the subject's repository to push to. */
  remote: string
  /** The branch pull requests target. */
  base: string
  /** The base branches System may merge into (ADR-0008); empty: none. */
  mergeInto: string[]
  apiUrl: string
  /** `owner/name`; parsed from a github.com remote URL when absent. */
  repository?: string
}

export interface PublishDeps {
  /** The GitHub token System holds; Workers never receive it. */
  token(): Promise<string | undefined>
  git?: typeof runGit
  /** Run the intent's required checks on a merge commit (a stored `git-tree@1`): needed for `merge: true`. */
  check?(subject: string, intent: EffectIntent): Promise<{ verdict: string; reason: string; evidence: string[] }>
}

/** How many times the merge queue follows a base that keeps moving before it gives up. */
const MERGE_ROUNDS = 3

/** `git merge-tree --write-tree`: the merged tree, or the files in conflict. */
function mergeTree(repository: string, tip: string, commit: string): Promise<{ tree: string } | { conflicts: string[] }> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repository, 'merge-tree', '--write-tree', '--name-only', '--no-messages', tip, commit], (error, stdout) => {
      const [tree, ...files] = stdout.trim().split('\n')
      if (!error) resolve({ tree: tree! })
      else if ((error as { code?: number }).code === 1) resolve({ conflicts: files.filter(Boolean) })
      else reject(new Error(`git merge-tree in ${repository} failed: ${error.message}`))
    })
  })
}

/** Run `run` after every earlier one for the same key has finished: one merge at a time per base. */
const queues = new Map<string, Promise<unknown>>()
function inQueue<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(run, run)
  queues.set(key, next.catch(() => undefined))
  return next
}

interface Pull {
  number: number
  html_url: string
  node_id: string
  draft: boolean
  base?: { ref: string }
  head?: { sha: string }
  merged_at?: string | null
  merge_commit_sha?: string | null
}

class GitHubError extends Error {
  status: number
  body: string
  constructor(message: string, status: number, body: string) {
    super(message)
    this.status = status
    this.body = body
  }
}

const READY = 'marking the pull request ready for review'

export const branchOf = (workId: string) => `system/${workId.replace(/^work:/, '')}`

export function githubPublisher(artifacts: Artifacts, deps: PublishDeps, config: PublishConfig): EffectPort {
  const git = deps.git ?? runGit

  function treeOf(subject: string): GitTreeContent {
    const read = artifacts.get(subject)
    if (read.state !== 'stored' || read.envelope.kind !== GIT_TREE_KIND.kind) throw new Error(`${subject} is not a stored git-tree Artifact`)
    return read.envelope.content as GitTreeContent
  }

  async function target(intent: EffectIntent) {
    const tree = treeOf(intent.subject)
    const url = (await git(tree.repository, ['remote', 'get-url', config.remote])).trim()
    const slug = config.repository ?? /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1]
    if (!slug) throw new Error(`cannot tell the GitHub repository of remote ${config.remote} (${url}); set repository`)
    const token = await deps.token()
    const env: Record<string, string> = token && url.startsWith('https://')
      ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` }
      : {}
    return { tree, url, slug, token, env, branch: branchOf(intent.workId) }
  }

  async function remoteCommit(t: Awaited<ReturnType<typeof target>>): Promise<string> {
    const listed = await git(t.tree.repository, ['ls-remote', t.url, `refs/heads/${t.branch}`], t.env)
    return listed.trim().split(/\s+/)[0] ?? ''
  }

  async function api<T>(t: Awaited<ReturnType<typeof target>>, method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${config.apiUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'System',
        ...(t.token ? { authorization: `Bearer ${t.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300)
      throw new GitHubError(`GitHub ${method} ${path}: HTTP ${response.status} ${text}`, response.status, text)
    }
    return (await response.json()) as T
  }

  const pullsOf = async (t: Awaited<ReturnType<typeof target>>, state: 'open' | 'all'): Promise<Pull[]> =>
    api<Pull[]>(t, 'GET', `/repos/${t.slug}/pulls?head=${encodeURIComponent(`${t.slug.split('/')[0]}:${t.branch}`)}&state=${state}`)

  /** The open pull request for the branch that targets the configured base. */
  const openPull = async (t: Awaited<ReturnType<typeof target>>): Promise<Pull | undefined> =>
    (await pullsOf(t, 'open')).find((p) => p.base?.ref === config.base)

  /** The base's tip on the remote, fetched so it can be merged with; '' when the base does not exist. */
  async function baseTip(t: Awaited<ReturnType<typeof target>>): Promise<string> {
    const tip = (await git(t.tree.repository, ['ls-remote', t.url, `refs/heads/${config.base}`], t.env)).trim().split(/\s+/)[0] ?? ''
    if (tip) await git(t.tree.repository, ['fetch', '--quiet', t.url, `refs/heads/${config.base}`], t.env)
    return tip
  }

  const holds = (t: Awaited<ReturnType<typeof target>>, ancestor: string, commit: string) =>
    git(t.tree.repository, ['merge-base', '--is-ancestor', ancestor, commit]).then(() => true, () => false)

  /** Push `commit` to the system branch, moving it only from a commit System published; then reuse or open its pull request. */
  async function publishBranch(t: Awaited<ReturnType<typeof target>>, intent: EffectIntent, commit: string, pull: Pull | undefined, ready: boolean): Promise<{ pull: Pull; draft: boolean }> {
    const current = await remoteCommit(t)
    if (current !== commit) {
      if (current) {
        const ours = await git(t.tree.repository, ['rev-parse', '--verify', '--quiet', `refs/system/artifacts/${current}`]).then(() => true, () => false)
        if (!ours) throw new Error(`${t.branch} holds ${current}, which System did not publish; resolve it by hand`)
      }
      await git(t.tree.repository, ['push', '--quiet', t.url, `${commit}:refs/heads/${t.branch}`, `--force-with-lease=refs/heads/${t.branch}:${current}`], t.env)
    }
    const merge = intent.params.merge === true
    pull ??= await api<Pull>(t, 'POST', `/repos/${t.slug}/pulls`, {
      title: `System ${t.branch.slice('system/'.length, 'system/'.length + 8)}: ${t.tree.commit.slice(0, 12)}`,
      head: t.branch, base: config.base, draft: !merge,
      body: [`Opened by System for Work \`${intent.workId}\`.`, '', `- commit: \`${t.tree.commit}\``, `- operation: \`${intent.operationId}\``, '', merge ? `System merges this change into ${config.base} through its merge queue once the checks have passed on the merge with ${config.base}.` : 'System does not merge this pull request; review and merge by hand.'].join('\n'),
    })
    if (ready && pull.draft) {
      await api(t, 'POST', '/graphql', {
        query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }',
        variables: { id: pull.node_id },
      })
      return { pull, draft: false }
    }
    return { pull, draft: pull.draft }
  }

  /** The merge queue for one change: see the module comment. */
  async function mergeIn(t: Awaited<ReturnType<typeof target>>, intent: EffectIntent, open: Pull | undefined): Promise<EffectOutcome> {
    const change = t.tree.commit
    const failed = (reason: string): EffectOutcome => ({ state: 'failed', reason, detail: { repository: t.slug, branch: t.branch, commit: change } })
    for (let round = 0; round < MERGE_ROUNDS; round++) {
      const tip = await baseTip(t)
      if (!tip) return failed(`${config.base} does not exist on ${config.remote}`)
      if (await holds(t, change, tip)) return { state: 'applied', reason: `${config.base} already holds ${change}`, detail: { repository: t.slug, branch: t.branch, commit: change, merged: 'true', mergeCommit: tip } }
      let commit = change
      let checkedOn: string | undefined
      if (!(await holds(t, tip, change))) {
        const merged = await mergeTree(t.tree.repository, tip, change)
        if ('conflicts' in merged) return failed(`merge conflict with ${config.base} at ${tip.slice(0, 12)}: ${merged.conflicts.join(', ')}`)
        commit = (await git(t.tree.repository, ['commit-tree', merged.tree, '-p', tip, '-p', change, '-m', `Merge ${t.branch} into ${config.base}`])).trim()
        await pin(t.tree.repository, commit)
        const subject = (await artifacts.put({
          ...GIT_TREE_KIND, content: { repository: t.tree.repository, commit, tree: merged.tree, parent: tip }, subject: { type: 'git-commit', ref: commit },
          classification: 'local-private', producer: { type: 'system', ref: 'git.publish' },
        })).id
        if (!deps.check) return failed('the merge queue has no checks to run on the merge')
        const checked = await deps.check(subject, intent)
        if (checked.verdict !== 'pass') return failed(`checks on the merge with ${config.base} at ${tip.slice(0, 12)}: ${checked.verdict}: ${checked.reason}`)
        checkedOn = tip
      }
      const { pull } = await publishBranch(t, intent, commit, open, true)
      open = pull
      try {
        await git(t.tree.repository, ['push', '--quiet', t.url, `${commit}:refs/heads/${config.base}`, `--force-with-lease=refs/heads/${config.base}:${tip}`], t.env)
      } catch (error) {
        // The lease failed only if the base moved: merge again with the new tip.
        if ((await git(t.tree.repository, ['ls-remote', t.url, `refs/heads/${config.base}`], t.env)).startsWith(tip)) throw error
        continue
      }
      return {
        state: 'applied', reason: `merged ${change} into ${config.base} as ${commit}${checkedOn ? `, checked on its merge with ${checkedOn.slice(0, 12)}` : ''}`,
        detail: { ...detail(t, pull, false, commit), ...(checkedOn ? { checkedOn } : {}) },
      }
    }
    return failed(`${config.base} kept moving during ${MERGE_ROUNDS} merges; run the step again`)
  }

  const detail = (t: Awaited<ReturnType<typeof target>>, pull: Pull, draft: boolean, merge?: string): Record<string, string> => ({
    repository: t.slug, branch: t.branch, commit: t.tree.commit, pullRequest: String(pull.number), url: pull.html_url, draft: String(draft),
    ...(merge ? { merged: 'true', mergeCommit: merge } : {}),
  })

  return {
    ref: 'github',
    version: '1',
    capabilities: ['git.publish'],
    accepts: [GIT_TREE_KIND.kind],
    validate(_capability, params) {
      for (const key of Object.keys(params)) if (key !== 'ready' && key !== 'merge') throw new Error(`unknown parameter ${key}; git.publish takes only ready and merge`)
      if ('ready' in params && typeof params.ready !== 'boolean') throw new Error('ready must be true or false')
      if ('merge' in params && typeof params.merge !== 'boolean') throw new Error('merge must be true or false')
      if (params.merge === true && params.ready === true) throw new Error('merge and ready cannot be combined; a merged pull request is already ready')
      if (params.merge === true && !config.mergeInto.includes(config.base)) {
        throw new Error(`merge: true is refused: base ${config.base} is not in mergeInto [${config.mergeInto.join(', ')}], the branches System may merge into`)
      }
    },
    approval: (intent) => (intent.params.ready === true ? READY : undefined),
    async apply(intent): Promise<EffectOutcome> {
      const t = await target(intent)
      const merge = intent.params.merge === true
      // ADR-0008 decision 2: a pull request for the branch aimed elsewhere is never merged or retargeted.
      const open = await pullsOf(t, 'open')
      let pull = open.find((p) => p.base?.ref === config.base)
      const elsewhere = open.find((p) => p.base?.ref !== config.base)
      if (!pull && elsewhere) {
        return { state: 'failed', reason: `pull request #${elsewhere.number} for ${t.branch} targets ${elsewhere.base?.ref ?? 'an unknown base'}, not ${config.base}; resolve it by hand`, detail: detail(t, elsewhere, elsewhere.draft) }
      }
      if (merge) return inQueue(`${t.url}#${config.base}`, () => mergeIn(t, intent, pull))
      const published = await publishBranch(t, intent, t.tree.commit, pull, intent.params.ready === true)
      const draft = published.draft
      pull = published.pull
      return { state: 'applied', reason: `pushed ${t.tree.commit} to ${t.branch} and ${draft ? 'opened a draft' : 'marked ready'} pull request #${pull.number}`, detail: detail(t, pull, draft) }
    },
    async reconcile(intent): Promise<Reconciled> {
      const merge = intent.params.merge === true
      let t: Awaited<ReturnType<typeof target>>
      let current: string
      try {
        t = await target(intent)
        if (merge) {
          const tip = await baseTip(t)
          if (tip && await holds(t, t.tree.commit, tip)) return { state: 'applied', reason: `${config.base} holds ${t.tree.commit}`, detail: { repository: t.slug, branch: t.branch, commit: t.tree.commit, merged: 'true', mergeCommit: tip } }
          return { state: 'absent', reason: `${config.base} does not hold ${t.tree.commit}` }
        }
        current = await remoteCommit(t)
      } catch (error) {
        return { state: 'unknown', reason: `cannot read the remote: ${(error as Error).message}` }
      }
      if (current !== t.tree.commit) return { state: 'absent', reason: `branch ${t.branch} does not hold ${t.tree.commit}` }
      let pull: Pull | undefined
      try {
        pull = await openPull(t)
      } catch (error) {
        return { state: 'unknown', reason: `cannot read pull requests: ${(error as Error).message}` }
      }
      if (!pull) return { state: 'absent', reason: `branch ${t.branch} holds the commit, but no open pull request` }
      if (intent.params.ready === true && pull.draft) return { state: 'absent', reason: `pull request #${pull.number} is still a draft` }
      return { state: 'applied', reason: `branch ${t.branch} holds the commit; pull request #${pull.number} is open`, detail: detail(t, pull, pull.draft) }
    },
  }
}
