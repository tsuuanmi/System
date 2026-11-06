/**
 * `git.publish` for GitHub (ADR-0004 decisions 10-11): push the exact verified
 * commit to `system/<work>` on the subject repository's remote, and open one
 * draft pull request for that branch. It never merges.
 *
 * - apply is idempotent per Work: a branch already at the commit is not
 *   pushed again, and an open pull request for the branch is reused.
 * - The branch moves only from a commit System published (pinned under
 *   `refs/system/artifacts/`), with a lease on the commit just read; any
 *   other commit there is refused.
 * - reconcile only reads: `applied` when the branch holds the commit and its
 *   pull request is open (and ready, if asked); `absent` otherwise; `unknown`
 *   when the remote or API cannot be read.
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
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`)
    return (await response.json()) as T
  }

  const openPull = async (t: Awaited<ReturnType<typeof target>>): Promise<Pull | undefined> =>
    (await api<Pull[]>(t, 'GET', `/repos/${t.slug}/pulls?head=${encodeURIComponent(`${t.slug.split('/')[0]}:${t.branch}`)}&state=open`))[0]

  const detail = (t: Awaited<ReturnType<typeof target>>, pull: Pull, draft: boolean): Record<string, string> => ({
    repository: t.slug, branch: t.branch, commit: t.tree.commit, pullRequest: String(pull.number), url: pull.html_url, draft: String(draft),
  })

  return {
    ref: 'github',
    version: '1',
    capabilities: ['git.publish'],
    accepts: [GIT_TREE_KIND.kind],
    validate(_capability, params) {
      for (const key of Object.keys(params)) if (key !== 'ready') throw new Error(`unknown parameter ${key}; git.publish takes only ready`)
      if ('ready' in params && typeof params.ready !== 'boolean') throw new Error('ready must be true or false')
    },
    approval: (intent) => (intent.params.ready === true ? READY : undefined),
    async apply(intent): Promise<EffectOutcome> {
      const t = await target(intent)
      const current = await remoteCommit(t)
      if (current !== t.tree.commit) {
        if (current) {
          const ours = await git(t.tree.repository, ['rev-parse', '--verify', '--quiet', `refs/system/artifacts/${current}`]).then(() => true, () => false)
          if (!ours) throw new Error(`${t.branch} holds ${current}, which System did not publish; resolve it by hand`)
        }
        await git(t.tree.repository, ['push', '--quiet', t.url, `${t.tree.commit}:refs/heads/${t.branch}`, `--force-with-lease=refs/heads/${t.branch}:${current}`], t.env)
      }
      const pull = (await openPull(t)) ?? await api<Pull>(t, 'POST', `/repos/${t.slug}/pulls`, {
        title: `System ${t.branch.slice('system/'.length, 'system/'.length + 8)}: ${t.tree.commit.slice(0, 12)}`,
        head: t.branch, base: config.base, draft: true,
        body: [`Opened by System for Work \`${intent.workId}\`.`, '', `- commit: \`${t.tree.commit}\``, `- operation: \`${intent.operationId}\``, '', 'System never merges; review and merge by hand.'].join('\n'),
      })
      let draft = pull.draft
      if (intent.params.ready === true && draft) {
        await api(t, 'POST', '/graphql', {
          query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }',
          variables: { id: pull.node_id },
        })
        draft = false
      }
      return { state: 'applied', reason: `pushed ${t.tree.commit} to ${t.branch} and ${draft ? 'opened a draft' : 'marked ready'} pull request #${pull.number}`, detail: detail(t, pull, draft) }
    },
    async reconcile(intent): Promise<Reconciled> {
      let t: Awaited<ReturnType<typeof target>>
      let current: string
      try {
        t = await target(intent)
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
