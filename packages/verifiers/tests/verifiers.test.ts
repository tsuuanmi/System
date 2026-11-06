/**
 * Both verifiers against a real git repository, a local HTTP server and the
 * real Artifact store over in-memory tables.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { Artifacts } from '@system/artifacts'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { processSpawner } from '../../../test-support/process.ts'
import { GIT_TREE_KIND, TASK_KIND, captureTree, gitTreeSchema, snapshot, taskSchema, type GitTreeContent } from '@system/work'
import { CHECKS_KIND, CHECK_RUN_KIND, checkRunSchema, checksSchema, requiredChecks } from '../src/checks.ts'
import { CITATION_CHECK_KIND, CITATION_CRITERIA_KIND, citationCheck, citationCheckSchema, citationCriteriaSchema, normalize } from '../src/citations.ts'

const root = mkdtempSync(join(tmpdir(), 'system-verifiers-'))
let server: Server
let base = ''

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/article') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body><p>System verifies <b>citations</b>&nbsp;exactly &amp; carefully.</p><script>var hidden = "secret quote here"</script></body></html>')
    } else {
      res.writeHead(404)
      res.end('not found')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
after(() => {
  server.close()
  rmSync(root, { recursive: true, force: true })
})

const store = () => memoryArtifacts(
  { ...TASK_KIND, content: taskSchema }, { ...GIT_TREE_KIND, content: gitTreeSchema }, { ...CHECKS_KIND, content: checksSchema },
  { ...CHECK_RUN_KIND, content: checkRunSchema }, { ...CITATION_CRITERIA_KIND, content: citationCriteriaSchema }, { ...CITATION_CHECK_KIND, content: citationCheckSchema },
).artifacts
const producer = { type: 'operator' as const, ref: 'tester' }

function repo(checksYaml?: string): string {
  const dir = mkdtempSync(join(root, 'repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  git('init', '--quiet')
  writeFileSync(join(dir, 'value.txt'), 'good\n')
  if (checksYaml) {
    mkdirSync(join(dir, '.system'))
    writeFileSync(join(dir, '.system', 'checks.yaml'), checksYaml)
  }
  git('add', '.')
  git('commit', '--quiet', '-m', 'base')
  return dir
}

async function taskOn(artifacts: Artifacts, repository: string): Promise<{ task: string; tree: GitTreeContent; treeId: string }> {
  const tree = await snapshot(repository)
  const treeId = (await artifacts.put({ ...GIT_TREE_KIND, content: tree, classification: 'local-private', producer })).id
  const task = (await artifacts.put({ ...TASK_KIND, content: { instructions: 'x', base: treeId }, inputs: [treeId], classification: 'local-private', producer })).id
  return { task, tree, treeId }
}

/** Commit a change on top of `base` in a scratch worktree, as an attempt would. */
async function change(artifacts: Artifacts, repository: string, baseCommit: string, files: Record<string, string>): Promise<string> {
  const work = mkdtempSync(join(root, 'wt-'))
  rmSync(work, { recursive: true })
  execFileSync('git', ['-C', repository, 'worktree', 'add', '--detach', '--quiet', work, baseCommit])
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(work, path, '..'), { recursive: true })
    writeFileSync(join(work, path), text)
  }
  const captured = await captureTree(repository, work, baseCommit, 'change')
  execFileSync('git', ['-C', repository, 'worktree', 'remove', '--force', work])
  return (await artifacts.put({ ...GIT_TREE_KIND, content: captured, classification: 'local-private', producer })).id
}

const CHECKS = 'checks:\n  - name: value-is-good\n    run: grep -qx good value.txt\n  - name: prints\n    run: echo checked\n'

test('criteria are pinned from .system/checks.yaml at the base commit, refused when absent or invalid', async () => {
  const artifacts = store()
  const verifier = requiredChecks(artifacts, processSpawner)
  const pinned = await verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: (await taskOn(artifacts, repo(CHECKS))).task, operatorId: 't' })
  const read = artifacts.get(pinned)
  assert.equal(read.state === 'stored' && read.envelope.kind, 'checks')
  assert.deepEqual(read.state === 'stored' && (read.envelope.content as { checks: { name: string }[] }).checks.map((c) => c.name), ['value-is-good', 'prints'])
  await assert.rejects(() => verifier.criteria({ capability: 'x', name: 'n', input: undefined, operatorId: 't' }), /no input task/)
  await assert.rejects(async () => verifier.criteria({ capability: 'x', name: 'n', input: (await taskOn(artifacts, repo())).task, operatorId: 't' }), /no \.system\/checks\.yaml at commit/)
  await assert.rejects(async () => verifier.criteria({ capability: 'x', name: 'n', input: (await taskOn(artifacts, repo('checks: []\n'))).task, operatorId: 't' }), /is invalid/)
})

test('checks run on the exact subject commit: a good change passes with one evidence Artifact per check', async () => {
  const artifacts = store()
  const repository = repo(CHECKS)
  const { task, tree } = await taskOn(artifacts, repository)
  const verifier = requiredChecks(artifacts, processSpawner)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'v1', input: task, operatorId: 't' })
  const subject = await change(artifacts, repository, tree.commit, { 'NOTES.md': 'added\n' })
  const result = await verifier.verify({ workId: 'w', attemptId: 'a', stepId: 'checks', capability: 'code.required-checks', subject, criteria })
  assert.equal(result.verdict, 'pass', result.reason)
  assert.deepEqual([result.subject, result.criteria, result.evidence.length], [subject, criteria, 2])
  const run = artifacts.get(result.evidence[1]!)
  assert.equal(run.state === 'stored' && (run.envelope.content as { stdoutTail: string }).stdoutTail, 'checked\n')
  assert.equal(execFileSync('git', ['-C', repository, 'worktree', 'list'], { encoding: 'utf8' }).trim().split('\n').length, 1, 'the check worktree is removed')
})

test('a change that breaks a check fails; a Worker editing checks.yaml cannot weaken the pinned criteria', async () => {
  const artifacts = store()
  const repository = repo(CHECKS)
  const { task, tree } = await taskOn(artifacts, repository)
  const verifier = requiredChecks(artifacts, processSpawner)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'v1', input: task, operatorId: 't' })
  const subject = await change(artifacts, repository, tree.commit, { 'value.txt': 'bad\n', '.system/checks.yaml': 'checks:\n  - name: nothing\n    run: "true"\n' })
  const result = await verifier.verify({ workId: 'w', attemptId: 'a', stepId: 'checks', capability: 'code.required-checks', subject, criteria })
  assert.equal(result.verdict, 'fail')
  assert.match(result.reason, /value-is-good \(exit 1\)/)
})

test('a check over its timeout fails', async () => {
  const artifacts = store()
  const repository = repo('checks:\n  - name: slow\n    run: sleep 30\n    timeoutSeconds: 1\n')
  const { task, treeId } = await taskOn(artifacts, repository)
  const verifier = requiredChecks(artifacts, processSpawner)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'v1', input: task, operatorId: 't' })
  const result = await verifier.verify({ workId: 'w', attemptId: 'a', stepId: 'checks', capability: 'code.required-checks', subject: treeId, criteria })
  assert.equal(result.verdict, 'fail')
  assert.match(result.reason, /slow \(timed out after 1 s\)/)
})

async function sources(artifacts: Artifacts, json: unknown): Promise<string> {
  return (await artifacts.putBytes({ kind: 'file', schemaVersion: 1, data: Buffer.from(JSON.stringify(json)), mediaType: 'application/json', classification: 'public', producer })).id
}

async function cite(json: unknown) {
  const artifacts = store()
  const verifier = citationCheck(artifacts)
  const criteria = await verifier.criteria({ capability: 'research.citation-check', name: 'citations-v1', operatorId: 't' })
  const subject = await sources(artifacts, json)
  const result = await verifier.verify({ workId: 'w', attemptId: 'a', stepId: 'citations', capability: 'research.citation-check', subject, criteria })
  const evidence = artifacts.get(result.evidence[0]!)
  return { result, evidence: evidence.state === 'stored' ? evidence.envelope.content as { problems: string[]; results: { found: boolean; status: number | null; contentHash?: string }[] } : undefined }
}

test('a quote found at its URL passes, ignoring markup, entities, case and whitespace; evidence keeps the page hash', async () => {
  const { result, evidence } = await cite({ sources: [{ id: 's1', url: `${base}/article`, quote: 'system verifies CITATIONS exactly & carefully', claims: ['c'] }] })
  assert.equal(result.verdict, 'pass', result.reason)
  assert.equal(evidence?.results[0]?.status, 200)
  assert.match(evidence?.results[0]?.contentHash ?? '', /^sha256:/)
})

test('a quote not on the page, or only inside a script, is inconclusive, never a pass', async () => {
  assert.equal((await cite({ sources: [{ id: 's1', url: `${base}/article`, quote: 'a sentence the page never says', claims: ['c'] }] })).result.verdict, 'inconclusive')
  assert.equal((await cite({ sources: [{ id: 's1', url: `${base}/article`, quote: 'secret quote here', claims: ['c'] }] })).result.verdict, 'inconclusive')
})

test('an unreachable or missing page is inconclusive', async () => {
  assert.equal((await cite({ sources: [{ id: 's1', url: `${base}/gone`, quote: 'system verifies citations', claims: ['c'] }] })).result.verdict, 'inconclusive')
  const closed = (await cite({ sources: [{ id: 's1', url: 'http://127.0.0.1:1/x', quote: 'system verifies citations', claims: ['c'] }] }))
  assert.equal(closed.result.verdict, 'inconclusive')
  assert.equal(closed.evidence?.results[0]?.status, null)
})

test('a malformed sources file, no sources, or an empty quote fails', async () => {
  assert.equal((await cite({ sources: [] })).result.verdict, 'fail')
  assert.equal((await cite({ sources: [{ id: 's1', url: 'ftp://x/y', quote: 'long enough quote', claims: ['c'] }] })).result.verdict, 'fail')
  assert.equal((await cite({ sources: [{ id: 's1', url: `${base}/article`, quote: 'short', claims: ['c'] }] })).result.verdict, 'fail')
  assert.equal((await cite({ sources: [{ id: 's1', url: `${base}/article`, quote: 'system verifies citations', claims: [] }] })).result.verdict, 'fail')
  assert.equal((await cite('not an object')).result.verdict, 'fail')
})

test('normalize folds markup, entities, typographic quotes and whitespace', () => {
  assert.equal(normalize('<p>It’s  &quot;A&quot;\n<b>B</b></p>'), 'it\'s "a" b')
})
