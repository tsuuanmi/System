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
 *   A conflict or a failing check returns `rejected: 'conflict' | 'merge-check'` and
 *   `detail.base`, the git-tree Artifact of the tip, so a Workflow's `retry.onFail`
 *   can reopen the change on it (sc-7); no other failure sets `rejected`.
 *   The base then moves to exactly that commit with a lease on the tip it was
 *   checked on (bors' "not rocket science" rule); if the base moved meanwhile,
 *   the change is merged and checked again on the new tip. The pull request is
 *   opened ready, for the record; GitHub's merge endpoint is not used.
 * - reconcile only reads the remote: `applied` when the branch holds the commit
 *   and its pull request is open (and ready, if asked) or, with `merge`, when the
 *   base holds the change; `absent` otherwise; `unknown` when it cannot be read.
 * - Build and cache output is never published (fl-8, Escaped defect 1): before any push,
 *   the files the change adds to its base are listed; one under `__pycache__/` or
 *   `node_modules/`, a `*.pyc` or `.DS_Store`, or one the base's own .gitignore ignores,
 *   fails the change as `rejected: 'build-output'` naming the files, with no `detail.base`.
 *   The Worker's step that lists the publish step in `retry.onFail` is reopened with the reason.
 * - The token reaches git through `GIT_CONFIG_*` environment variables, never
 *   its arguments, and the API through the Authorization header.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Artifacts } from '@system/artifacts'
import { GIT_TREE_KIND, git as runGit, pin, type EffectIntent, type EffectOutcome, type EffectPort, type GitTreeContent, type Reconciled } from '@system/work'

/** What the merge queue's re-check says of a merge commit: `pass` merges, `hold` waits for an operator's Approval of that commit, anything else is refused. `verdicts` are the stored verdict Artifacts. */
export interface MergeCheck {
  verdict: 'pass' | 'hold' | 'fail' | 'error' | 'inconclusive'
  reason: string
  evidence: string[]
  verdicts?: string[]
}

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
  check?(subject: string, intent: EffectIntent): Promise<MergeCheck>
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

/** Build or cache output by name, whatever any .gitignore says. */
const BUILD_OUTPUT = /(^|\/)(__pycache__|node_modules)\/|\.pyc$|(^|\/)\.DS_Store$/

/** Of `paths`, those the .gitignore files held by `base` ignore (`git check-ignore --no-index`, run over a scratch copy of just those files, so the change's own .gitignore counts for nothing). */
async function ignoredAt(git: typeof runGit, repository: string, base: string, paths: string[]): Promise<string[]> {
  const scratch = mkdtempSync(join(tmpdir(), 'system-ignore-'))
  try {
    await git(scratch, ['init', '--quiet'])
    const files = (await git(repository, ['ls-tree', '-r', '--name-only', '-z', base])).split('\0').filter((f) => f === '.gitignore' || f.endsWith('/.gitignore'))
    for (const file of files) {
      mkdirSync(dirname(join(scratch, file)), { recursive: true })
      writeFileSync(join(scratch, file), await git(repository, ['show', `${base}:${file}`]))
    }
    return await new Promise<string[]>((resolve, reject) => {
      const child = execFile('git', ['-C', scratch, 'check-ignore', '--no-index', '-z', '--stdin'], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
        if (!error || (error as { code?: number }).code === 1) resolve(stdout.split('\0').filter(Boolean))
        else reject(new Error(`git check-ignore failed: ${error.message}`))
      })
      child.stdin!.end(paths.join('\0'))
    })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
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

/** tr-1: the existing tests the change modified or deleted, each with the Worker's reason; nothing when the Work record holds no list for the subject. */
function changedTestsSection(intent: EffectIntent): string[] {
  const tests = intent.changedTests
  if (!tests) return []
  if (!tests.length) return ['Changed tests: none.', '']
  return ['Changed tests (existing test files this change modified or deleted):', ...tests.map((t) => `- \`${t.path}\` (${t.change}): ${t.reason}`), '']
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

  /** fl-8: the build or cache files the change adds to its base (its parent, else the merge base with the remote-tracking base branch). */
  async function buildOutput(t: Awaited<ReturnType<typeof target>>): Promise<string[]> {
    const repository = t.tree.repository
    let base = t.tree.parent
    if (!base) {
      // No network: the remote-tracking ref this repository already holds.
      base = (await git(repository, ['merge-base', `refs/remotes/${config.remote}/${config.base}`, t.tree.commit]).catch(() => '')).trim()
    }
    const against = base || (await git(repository, ['hash-object', '-t', 'tree', '/dev/null'])).trim()
    const added = (await git(repository, ['diff', '--no-renames', '--name-only', '-z', '--diff-filter=A', against, t.tree.commit])).split('\0').filter(Boolean)
    const named = added.filter((f) => BUILD_OUTPUT.test(f))
    const rest = added.filter((f) => !BUILD_OUTPUT.test(f))
    const ignored = base && rest.length ? await ignoredAt(git, repository, base, rest) : []
    return [...named, ...ignored].sort()
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

  /** The branch's open pull requests. */
  const pullsOf = async (t: Awaited<ReturnType<typeof target>>): Promise<Pull[]> =>
    api<Pull[]>(t, 'GET', `/repos/${t.slug}/pulls?head=${encodeURIComponent(`${t.slug.split('/')[0]}:${t.branch}`)}&state=open`)

  /** The open pull request for the branch that targets the configured base. */
  const openPull = async (t: Awaited<ReturnType<typeof target>>): Promise<Pull | undefined> =>
    (await pullsOf(t)).find((p) => p.base?.ref === config.base)

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
      body: [`Opened by System for Work \`${intent.workId}\`.`, '', `- commit: \`${t.tree.commit}\``, `- operation: \`${intent.operationId}\``, '', ...changedTestsSection(intent), merge ? `System merges this change into ${config.base} through its merge queue once the checks have passed on the merge with ${config.base}.` : 'System does not merge this pull request; review and merge by hand.'].join('\n'),
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
    /** A refusal a new change on the newer base can fix: `detail.base` is the Artifact of the tip, handed to the Worker as its starting point (sc-7). */
    const rejected = async (kind: 'conflict' | 'merge-check', tip: string, reason: string): Promise<EffectOutcome> => {
      const tree = (await git(t.tree.repository, ['rev-parse', `${tip}^{tree}`])).trim()
      await pin(t.tree.repository, tip)
      const base = (await artifacts.put({
        ...GIT_TREE_KIND, content: { repository: t.tree.repository, commit: tip, tree, parent: tip }, subject: { type: 'git-commit', ref: tip },
        classification: 'local-private', producer: { type: 'system', ref: 'git.publish' },
      })).id
      return { state: 'failed', rejected: kind, reason, detail: { repository: t.slug, branch: t.branch, commit: change, baseCommit: tip, base } }
    }
    /** The commit of the approved merge Artifact, if it was made on `tip`. */
    const approvedOn = (subject: string, tip: string): string | undefined => {
      const read = artifacts.get(subject)
      const content = read.state === 'stored' && read.envelope.kind === GIT_TREE_KIND.kind ? read.envelope.content as { commit: string; parent?: string } : undefined
      return content?.parent === tip ? content.commit : undefined
    }
    const named = (ids: string[]): Record<string, string> => (ids.length ? { verdicts: ids.join(',') } : {})
    for (let round = 0; round < MERGE_ROUNDS; round++) {
      const tip = await baseTip(t)
      if (!tip) return failed(`${config.base} does not exist on ${config.remote}`)
      if (await holds(t, change, tip)) return { state: 'applied', reason: `${config.base} already holds ${change}`, detail: { repository: t.slug, branch: t.branch, commit: change, merged: 'true', mergeCommit: tip } }
      let commit = change
      let checkedOn: string | undefined
      let approvedMerge = false
      let verdicts: string[] = []
      if (!(await holds(t, tip, change))) {
        // The merge commit an operator approved is pushed as it is while the base is still the tip it was made on; any other is checked.
        const approved = intent.approvedMerge ? approvedOn(intent.approvedMerge, tip) : undefined
        if (approved) {
          commit = approved
          approvedMerge = true
        } else {
          const merged = await mergeTree(t.tree.repository, tip, change)
          if ('conflicts' in merged) return rejected('conflict', tip, `merge conflict with ${config.base} at ${tip.slice(0, 12)}: ${merged.conflicts.join(', ')}`)
          commit = (await git(t.tree.repository, ['commit-tree', merged.tree, '-p', tip, '-p', change, '-m', `Merge ${t.branch} into ${config.base}`])).trim()
          await pin(t.tree.repository, commit)
          const subject = (await artifacts.put({
            ...GIT_TREE_KIND, content: { repository: t.tree.repository, commit, tree: merged.tree, parent: tip }, subject: { type: 'git-commit', ref: commit },
            classification: 'local-private', producer: { type: 'system', ref: 'git.publish' },
          })).id
          if (!deps.check) return failed('the merge queue has no checks to run on the merge')
          const checked = await deps.check(subject, intent)
          verdicts = checked.verdicts ?? []
          const why = `checks on the merge with ${config.base} at ${tip.slice(0, 12)}: ${checked.verdict}: ${checked.reason}`
          if (checked.verdict === 'hold') return { ...failed(why), held: subject, detail: { ...failed(why).detail, mergeCommit: commit, ...named(verdicts) } }
          if (checked.verdict !== 'pass') {
            const refused = await rejected('merge-check', tip, why)
            return { ...refused, detail: { ...refused.detail, ...named(verdicts) } }
          }
          checkedOn = tip
        }
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
        state: 'applied', reason: `merged ${change} into ${config.base} as ${commit}${checkedOn ? `, checked on its merge with ${checkedOn.slice(0, 12)}` : ''}${approvedMerge ? ', approved by the operator' : ''}`,
        detail: { ...detail(t, pull, false, commit), ...(checkedOn ? { checkedOn } : {}), ...named(verdicts) },
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
      const output = await buildOutput(t)
      if (output.length) {
        return { state: 'failed', rejected: 'build-output', reason: `the change adds build or cache output, which is never published; remove ${output.join(', ')} from it (and keep it out of the commit)`, detail: { repository: t.slug, branch: t.branch, commit: t.tree.commit } }
      }
      // ADR-0008 decision 2: a pull request for the branch aimed elsewhere is never merged or retargeted.
      const open = await pullsOf(t)
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
