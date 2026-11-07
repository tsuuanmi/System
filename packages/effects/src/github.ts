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
 * - merge: the pull request is opened ready, and merged with the commit as
 *   `sha`, so GitHub refuses if the head moved. A 405 or 409 is `failed`, never
 *   retried; a pull request already merged at the commit is not merged again.
 * - reconcile only reads: `applied` when the branch holds the commit and its
 *   pull request is open (and ready, if asked) or, with `merge`, merged at the
 *   commit; `absent` otherwise; `unknown` when the remote or API cannot be read.
 * - The token reaches git through `GIT_CONFIG_*` environment variables, never
 *   its arguments, and the API through the Authorization header.
 */
import type { Artifacts } from '@system/artifacts'
import { GIT_TREE_KIND, git as runGit, type EffectIntent, type EffectOutcome, type EffectPort, type GitTreeContent, type Reconciled } from '@system/work'

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

  /** The pull request for the branch that was merged into the configured base at the commit, if any. */
  const mergedPull = async (t: Awaited<ReturnType<typeof target>>): Promise<Pull | undefined> =>
    (await pullsOf(t, 'all')).find((p) => p.merged_at && p.base?.ref === config.base && p.head?.sha === t.tree.commit)

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
      if (merge) {
        const done = await mergedPull(t)
        if (done) return { state: 'applied', reason: `pull request #${done.number} is already merged at ${t.tree.commit}`, detail: detail(t, done, false, done.merge_commit_sha ?? '') }
      }
      // ADR-0008 decision 2: a pull request for the branch aimed elsewhere is never merged or retargeted.
      const open = await pullsOf(t, 'open')
      let pull = open.find((p) => p.base?.ref === config.base)
      const elsewhere = open.find((p) => p.base?.ref !== config.base)
      if (!pull && elsewhere) {
        return { state: 'failed', reason: `pull request #${elsewhere.number} for ${t.branch} targets ${elsewhere.base?.ref ?? 'an unknown base'}, not ${config.base}; resolve it by hand`, detail: detail(t, elsewhere, elsewhere.draft) }
      }
      const current = await remoteCommit(t)
      if (current !== t.tree.commit) {
        if (current) {
          const ours = await git(t.tree.repository, ['rev-parse', '--verify', '--quiet', `refs/system/artifacts/${current}`]).then(() => true, () => false)
          if (!ours) throw new Error(`${t.branch} holds ${current}, which System did not publish; resolve it by hand`)
        }
        await git(t.tree.repository, ['push', '--quiet', t.url, `${t.tree.commit}:refs/heads/${t.branch}`, `--force-with-lease=refs/heads/${t.branch}:${current}`], t.env)
      }
      pull ??= await api<Pull>(t, 'POST', `/repos/${t.slug}/pulls`, {
        title: `System ${t.branch.slice('system/'.length, 'system/'.length + 8)}: ${t.tree.commit.slice(0, 12)}`,
        head: t.branch, base: config.base, draft: !merge,
        body: [`Opened by System for Work \`${intent.workId}\`.`, '', `- commit: \`${t.tree.commit}\``, `- operation: \`${intent.operationId}\``, '', merge ? `System merges this pull request into ${config.base} once the checks have passed on this commit.` : 'System does not merge this pull request; review and merge by hand.'].join('\n'),
      })
      let draft = pull.draft
      if ((intent.params.ready === true || merge) && draft) {
        await api(t, 'POST', '/graphql', {
          query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }',
          variables: { id: pull.node_id },
        })
        draft = false
      }
      if (merge) {
        try {
          const merged = await api<{ sha: string }>(t, 'PUT', `/repos/${t.slug}/pulls/${pull.number}/merge`, { sha: t.tree.commit, merge_method: 'merge' })
          return { state: 'applied', reason: `pushed ${t.tree.commit} to ${t.branch} and merged pull request #${pull.number} into ${config.base}`, detail: detail(t, pull, false, merged.sha) }
        } catch (error) {
          // 405: not mergeable; 409: the head is not the commit. Neither changes by retrying.
          if (error instanceof GitHubError && (error.status === 405 || error.status === 409)) {
            return { state: 'failed', reason: `GitHub refused to merge pull request #${pull.number}: ${error.body}`, detail: detail(t, pull, false) }
          }
          throw error
        }
      }
      return { state: 'applied', reason: `pushed ${t.tree.commit} to ${t.branch} and ${draft ? 'opened a draft' : 'marked ready'} pull request #${pull.number}`, detail: detail(t, pull, draft) }
    },
    async reconcile(intent): Promise<Reconciled> {
      const merge = intent.params.merge === true
      let t: Awaited<ReturnType<typeof target>>
      let current: string
      try {
        t = await target(intent)
        if (merge) {
          const done = await mergedPull(t)
          if (done) return { state: 'applied', reason: `pull request #${done.number} is merged at ${t.tree.commit}`, detail: detail(t, done, false, done.merge_commit_sha ?? '') }
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
      if (merge) return { state: 'absent', reason: `pull request #${pull.number} is open, not merged` }
      if (intent.params.ready === true && pull.draft) return { state: 'absent', reason: `pull request #${pull.number} is still a draft` }
      return { state: 'applied', reason: `branch ${t.branch} holds the commit; pull request #${pull.number} is open`, detail: detail(t, pull, pull.draft) }
    },
  }
}
