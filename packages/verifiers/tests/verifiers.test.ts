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
import { CHECKS_KIND, CHECK_RUN_KIND, checkEnvSchema, checkRunSchema, checksSchema, requiredChecks } from '../src/checks.ts'
import { CITATION_CHECK_KIND, CITATION_CRITERIA_KIND, citationCheck, citationCheckSchema, citationCriteriaSchema, normalize } from '../src/citations.ts'

const root = mkdtempSync(join(tmpdir(), 'system-verifiers-'))
/** The verifier's scratch directory is named by the attempt ID in the shared tmp: an ID of its own per test process, or a parallel run (or another user) removes the directory a check runs in and `spawn timeout` fails with ENOENT. */
const RUN = `t${process.pid}-${Date.now().toString(36)}`
let server: Server
let base = ''

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/article') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body><p>System verifies <b>citations</b>&nbsp;exactly &amp; carefully.</p><script>var hidden = "secret quote here"</script></body></html>')
    } else if (req.url === '/paris') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<p>Its capital, largest city and main cultural and economic centre is <a href="/wiki/Paris">Paris</a>, with a metropolitan population of over 13 million.</p>')
    } else if (req.url === '/france') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<p>Paris is the capital and most populous city of France.</p>')
    } else if (req.url === '/forbidden') {
      res.writeHead(403)
      res.end('no bots')
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

function repo(checksYaml?: string, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(root, 'repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  git('init', '--quiet')
  writeFileSync(join(dir, 'value.txt'), 'good\n')
  if (checksYaml) {
    mkdirSync(join(dir, '.system'))
    writeFileSync(join(dir, '.system', 'checks.yaml'), checksYaml)
  }
  for (const [path, text] of Object.entries(extra)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
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
async function change(artifacts: Artifacts, repository: string, baseCommit: string, files: Record<string, string | null>): Promise<string> {
  const work = mkdtempSync(join(root, 'wt-'))
  rmSync(work, { recursive: true })
  execFileSync('git', ['-C', repository, 'worktree', 'add', '--detach', '--quiet', work, baseCommit])
  for (const [path, text] of Object.entries(files)) {
    if (text === null) {
      rmSync(join(work, path), { force: true })
      continue
    }
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
  await assert.rejects(() => verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: undefined, operatorId: 't' }), /no input task/)
  await assert.rejects(async () => verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: (await taskOn(artifacts, repo())).task, operatorId: 't' }), /no \.system\/checks\.yaml at commit/)
  await assert.rejects(async () => verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: (await taskOn(artifacts, repo('checks: []\n'))).task, operatorId: 't' }), /is invalid/)
})

test('an unknown criteria name refuses admission, naming the known ones: a typo never means "every check passes"', async () => {
  const artifacts = store()
  const verifier = requiredChecks(artifacts, processSpawner)
  const { task } = await taskOn(artifacts, repo(CHECKS))
  for (const name of ['v1', 'red-vl', 'repo-checks-v2']) {
    await assert.rejects(verifier.criteria({ capability: 'code.required-checks', name, input: task, operatorId: 't' }), /unknown criteria .*repo-checks-v1, red-v1, tests-frozen-v1/, name)
  }
  for (const name of ['repo-checks-v1', 'red-v1', 'tests-frozen-v1']) await verifier.criteria({ capability: 'code.required-checks', name, input: task, operatorId: 't' })
})

test('a change given as the input is refused: the checks are read from a base the Worker did not write', async () => {
  const artifacts = store()
  const verifier = requiredChecks(artifacts, processSpawner)
  const { treeId } = await taskOn(artifacts, repo(CHECKS))
  await assert.rejects(verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: treeId, operatorId: 't' }), /a task with a base commit/)
})

test('checks run on the exact subject commit: a good change passes with one evidence Artifact per check', async () => {
  const artifacts = store()
  const repository = repo(CHECKS)
  const { task, tree } = await taskOn(artifacts, repository)
  const verifier = requiredChecks(artifacts, processSpawner)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: task, operatorId: 't' })
  const subject = await change(artifacts, repository, tree.commit, { 'NOTES.md': 'added\n' })
  const result = await verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'checks', capability: 'code.required-checks', subject, criteria })
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
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: task, operatorId: 't' })
  const subject = await change(artifacts, repository, tree.commit, { 'value.txt': 'bad\n', '.system/checks.yaml': 'checks:\n  - name: nothing\n    run: "true"\n' })
  const result = await verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'checks', capability: 'code.required-checks', subject, criteria })
  assert.equal(result.verdict, 'fail')
  assert.match(result.reason, /value-is-good \(exit 1\)/)
})

async function verifyChange(yaml: string, files: Record<string, string>, subjectIsBase = false, criteriaName = 'repo-checks-v1') {
  const artifacts = store()
  const repository = repo(yaml)
  const { task, tree, treeId } = await taskOn(artifacts, repository)
  const verifier = requiredChecks(artifacts, processSpawner)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: criteriaName, input: task, operatorId: 't' })
  const subject = subjectIsBase ? treeId : await change(artifacts, repository, tree.commit, files)
  const result = await verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'checks', capability: 'code.required-checks', subject, criteria })
  const runs = result.evidence.map((id) => {
    const read = artifacts.get(id)
    assert.equal(read.state, 'stored')
    assert.ok(read.state === 'stored' && read.envelope.kind === CHECK_RUN_KIND.kind)
    return checkRunSchema.parse(read.envelope.content)
  })
  return { result, runs, commits: runs.map((run) => run.commit), base: tree.commit, repository }
}

/** One shared counter in the verifier's throwaway HOME: fail the first N runs, then pass. */
const failFirst = (count: number) => `n=$(cat "$HOME/n" 2>/dev/null || echo 0); echo $((n+1)) > "$HOME/n"; [ "$n" -ge ${count} ]`
const flakyChecks = (count: number, red = false) => `checks:
  - name: transient
    run: '${failFirst(count)}'
${red ? '    red: fail\n' : ''}`

test('an inconclusive verdict follows the change when it passes on re-run', async () => {
  const { result, runs, commits, base, repository } = await verifyChange(flakyChecks(2), { 'NOTES.md': 'x\n' })
  assert.equal(result.verdict, 'pass', result.reason)
  assert.match(result.reason, /re-run/)
  assert.match(result.reason, /flaky/)
  assert.equal(result.evidence.length, 3, 'a recovered change does not run the base twice')
  assert.notEqual(commits[0], base)
  assert.deepEqual(commits, [commits[0], base, commits[0]])
  assert.deepEqual(runs.map((run) => run.exitCode), [1, 1, 0])
  assert.equal(execFileSync('git', ['-C', repository, 'worktree', 'list'], { encoding: 'utf8' }).trim().split('\n').length, 1, 'all worktrees are removed')
})

test("a base that passes on re-run makes the change's failure count", async () => {
  const { result, runs, commits, base } = await verifyChange(flakyChecks(3), { 'NOTES.md': 'x\n' })
  assert.equal(result.verdict, 'fail', result.reason)
  assert.match(result.reason, /failed:/)
  assert.match(result.reason, /re-run/)
  assert.notEqual(commits[0], base)
  assert.deepEqual(commits, [commits[0], base, commits[0], base])
  assert.deepEqual(runs.map((run) => run.exitCode), [1, 1, 1, 0])
})

test('still inconclusive after the re-run is held with all four runs as evidence', async () => {
  const { result, runs, commits, base } = await verifyChange('checks:\n  - name: ok\n    run: "true"\n  - name: broken\n    run: "false"\n', { 'NOTES.md': 'x\n' })
  assert.equal(result.verdict, 'inconclusive', result.reason)
  assert.match(result.reason, /also on a re-run/)
  assert.equal(result.evidence.length, 7)
  assert.notEqual(commits[0], base)
  assert.deepEqual(commits, [commits[0], commits[0], base, base, commits[0], base, base])
  assert.deepEqual(runs.map((run) => run.name), ['ok', 'broken', 'ok', 'broken', 'broken', 'ok', 'broken'])
  assert.deepEqual(runs.map((run) => run.exitCode), [0, 1, 0, 1, 1, 0, 1])
})

test('the re-run is bounded to one', async () => {
  const { result, runs, commits, base } = await verifyChange('checks:\n  - name: broken\n    run: "false"\n', { 'NOTES.md': 'x\n' })
  assert.equal(result.verdict, 'inconclusive', result.reason)
  assert.equal(runs.filter((run) => run.name === 'broken').length, 4, 'exactly two runs on the change and two on the base')
  assert.deepEqual(commits, [commits[0], base, commits[0], base])
})

test('red-v1: an inconclusive red follows the change on re-run', async () => {
  const { result, runs, commits, base } = await verifyChange(flakyChecks(2, true), { 'NOTES.md': 'x\n' }, false, 'red-v1')
  assert.equal(result.verdict, 'fail', result.reason)
  assert.match(result.reason, /no check with red: fail failed/)
  assert.match(result.reason, /re-run/)
  assert.deepEqual(commits, [commits[0], base, commits[0]])
  assert.deepEqual(runs.map((run) => run.exitCode), [1, 1, 0])
})

test('red-v1: red when the base passes on re-run', async () => {
  const { result, runs, commits, base } = await verifyChange(flakyChecks(3, true), { 'NOTES.md': 'x\n' }, false, 'red-v1')
  assert.equal(result.verdict, 'pass', result.reason)
  assert.match(result.reason, /failed as it should, and passes on the base/)
  assert.match(result.reason, /re-run/)
  assert.deepEqual(commits, [commits[0], base, commits[0], base])
  assert.deepEqual(runs.map((run) => run.exitCode), [1, 1, 1, 0])
})

test('a check the base fails too is inconclusive, with the evidence of both runs', async () => {
  const { result, commits, base, repository } = await verifyChange('checks:\n  - name: ok\n    run: "true"\n  - name: broken\n    run: "false"\n', { 'NOTES.md': 'x\n' })
  assert.equal(result.verdict, 'inconclusive')
  assert.match(result.reason, /broken/)
  assert.match(result.reason, /the base fails it too/)
  assert.match(result.reason, /also on a re-run/)
  assert.equal(result.evidence.length, 7)
  assert.notEqual(commits[0], base)
  assert.deepEqual(commits, [commits[0], commits[0], base, base, commits[0], base, base])
  assert.equal(execFileSync('git', ['-C', repository, 'worktree', 'list'], { encoding: 'utf8' }).trim().split('\n').length, 1, 'both worktrees are removed')
})

test('a check that passes on the base keeps the fail verdict, and the base was run', async () => {
  const { result } = await verifyChange('checks:\n  - name: value-is-good\n    run: grep -qx good value.txt\n', { 'value.txt': 'bad\n' })
  assert.equal(result.verdict, 'fail')
  assert.match(result.reason, /value-is-good \(exit 1\)/)
  assert.equal(result.evidence.length, 2)
})

test('when only some failed checks fail on the base too, the verdict is fail', async () => {
  const { result } = await verifyChange('checks:\n  - name: broken\n    run: "false"\n  - name: value-is-good\n    run: grep -qx good value.txt\n', { 'value.txt': 'bad\n' })
  assert.equal(result.verdict, 'fail')
})

test('nothing runs on the base when the subject is the base itself', async () => {
  const { result } = await verifyChange('checks:\n  - name: broken\n    run: "false"\n', {}, true)
  assert.equal(result.verdict, 'fail')
  assert.equal(result.evidence.length, 1)
})

test('the base run runs the checks before the failed one first', async () => {
  const { result } = await verifyChange('checks:\n  - name: setup\n    run: touch ready\n  - name: needs-ready\n    run: test -f ready && exit 1\n  - name: after\n    run: "true"\n', { 'NOTES.md': 'x\n' })
  assert.equal(result.verdict, 'inconclusive')
  assert.equal(result.evidence.length, 8, 'three on the change, two on the base, then one on the change and two on the base: nothing after the last failed check')
})

test('a check over its timeout fails', async () => {
  const artifacts = store()
  const repository = repo('checks:\n  - name: slow\n    run: sleep 30\n    timeoutSeconds: 1\n')
  const { task, treeId } = await taskOn(artifacts, repository)
  const verifier = requiredChecks(artifacts, processSpawner)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: task, operatorId: 't' })
  const result = await verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'checks', capability: 'code.required-checks', subject: treeId, criteria })
  assert.equal(result.verdict, 'fail')
  assert.match(result.reason, /slow \(timed out after 1 s\)/)
})

async function sources(artifacts: Artifacts, json: unknown): Promise<string> {
  return (await artifacts.putBytes({ kind: 'file', schemaVersion: 1, data: Buffer.from(JSON.stringify(json)), mediaType: 'application/json', classification: 'public', producer })).id
}

/** `criteria` pins other criteria content instead of the verifier's own defaults. */
async function cite(json: unknown, pinned?: Record<string, unknown>) {
  const artifacts = store()
  const verifier = citationCheck(artifacts)
  const criteria = pinned
    ? (await artifacts.put({ ...CITATION_CRITERIA_KIND, content: pinned, classification: 'public', producer })).id
    : await verifier.criteria({ capability: 'research.citation-check', name: 'citations-v1', operatorId: 't' })
  const subject = await sources(artifacts, json)
  const result = await verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'citations', capability: 'research.citation-check', subject, criteria })
  const evidence = artifacts.get(result.evidence[0]!)
  return { result, evidence: evidence.state === 'stored' ? evidence.envelope.content as { problems: string[]; minConfirmedRatio?: number; confirmedRatio?: number; results: { found: boolean; status: number | null; contentHash?: string }[] } : undefined }
}

test('a quote found at its URL passes, ignoring markup, entities, case and whitespace; evidence keeps the page hash', async () => {
  const { result, evidence } = await cite({ sources: [{ id: 's1', url: `${base}/article`, quote: 'system verifies CITATIONS exactly & carefully', claims: ['c'] }] })
  assert.equal(result.verdict, 'pass', result.reason)
  assert.equal(evidence?.results[0]?.status, 200)
  assert.match(evidence?.results[0]?.contentHash ?? '', /^sha256:/)
})

// Why not a pass any more: 0 of 1 confirmed is below the default ratio of 0.5, so a lone unconfirmed source still holds the Work.
test('a quote not on the page, or only inside a script, is not confirmed: inconclusive when it is the only source', async () => {
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

/** Like `cite`, with the `citations-v2` criteria the verifier pins itself, and the report as a second input when given. */
async function citeV2(json: unknown, report?: string) {
  const artifacts = store()
  const verifier = citationCheck(artifacts)
  const criteria = await verifier.criteria({ capability: 'research.citation-check', name: 'citations-v2', operatorId: 't' })
  const subject = await sources(artifacts, json)
  const reportId = report === undefined ? undefined : (await artifacts.putBytes({ kind: 'file', schemaVersion: 1, data: Buffer.from(report), mediaType: 'text/markdown', classification: 'public', producer })).id
  const result = await verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'citations', capability: 'research.citation-check', subject, criteria, ...(reportId ? { inputs: { report: reportId } } : {}) })
  const evidence = artifacts.get(result.evidence[0]!)
  return { result, evidence: evidence.state === 'stored' ? evidence.envelope.content as { problems: string[]; confirmedRatio?: number; results: { id: string; found: boolean; readable?: boolean; wordRatio?: number; passage?: string }[] } : undefined }
}

const parisQuote = 'Its capital, largest city and main cultural and economic centre is Paris.'
const franceQuote = 'Paris is the capital and largest city of France.'

test('v2: the shortened and the reworded canary quotes pass; v1 still rejects both', async () => {
  for (const [path, quote] of [['paris', parisQuote], ['france', franceQuote]] as const) {
    const json = { sources: [{ id: 's1', url: `${base}/${path}`, quote, claims: ['c'] }] }
    const v2 = await citeV2(json)
    assert.equal(v2.result.verdict, 'pass', v2.result.reason)
    assert.ok((v2.evidence?.results[0]?.wordRatio ?? 0) >= 0.8)
    assert.match(v2.evidence?.results[0]?.passage ?? '', /paris/)
    assert.ok((v2.evidence?.results[0]?.passage ?? '').length <= 300)
    assert.equal((await cite(json)).result.verdict, 'inconclusive')
  }
})

test('v2: a quote of other words is not confirmed; the reason names the source with its ratio', async () => {
  const { result, evidence } = await citeV2({ sources: [{ id: 's1', url: `${base}/france`, quote: 'Berlin is the largest metropolis on the river Spree', claims: ['c'] }] })
  assert.equal(result.verdict, 'inconclusive')
  assert.match(result.reason, /s1 \(HTTP 200, 22% of the quote/)
  assert.equal(evidence?.results[0]?.found, false)
})

test('v2: the words must come in order', async () => {
  const { evidence } = await citeV2({ sources: [{ id: 's1', url: `${base}/france`, quote: 'France of city populous most and capital the is Paris', claims: ['c'] }] })
  assert.equal(evidence?.results[0]?.found, false)
})

test('v2: a report citing [s2] with only s1 in sources fails, naming s2', async () => {
  const { result } = await citeV2({ sources: [{ id: 's1', url: `${base}/france`, quote: franceQuote, claims: ['c'] }] }, 'Paris is the capital [s1]. It is big [s2].')
  assert.equal(result.verdict, 'fail')
  assert.match(result.reason, /s2/)
  assert.doesNotMatch(result.reason, /s1/)
})

test('v2: a source the report never cites fails, naming it; Markdown links are not citations', async () => {
  const two = { sources: [
    { id: 's1', url: `${base}/france`, quote: franceQuote, claims: ['c'] },
    { id: 's2', url: `${base}/paris`, quote: parisQuote, claims: ['c'] },
  ] }
  const unused = await citeV2(two, 'Paris is the capital [s1]. See [the guide](https://example.com).')
  assert.equal(unused.result.verdict, 'fail')
  assert.match(unused.result.reason, /s2/)
  assert.equal((await citeV2(two, 'Paris [s1] [s2], [s1].')).result.verdict, 'pass')
})

test('v2: a 403 source is unreadable, not wrong: with one confirmed readable source it passes', async () => {
  const { result, evidence } = await citeV2({ sources: [
    { id: 's1', url: `${base}/france`, quote: franceQuote, claims: ['c'] },
    { id: 's2', url: `${base}/forbidden`, quote: parisQuote, claims: ['c'] },
  ] })
  assert.equal(result.verdict, 'pass', result.reason)
  assert.equal(evidence?.confirmedRatio, 1)
  assert.equal(evidence?.results[1]?.readable, false)
  assert.match(result.reason, /s2 \(HTTP 403/)
})

test('v2: when no source is readable the verdict is inconclusive', async () => {
  const { result, evidence } = await citeV2({ sources: [
    { id: 's1', url: `${base}/forbidden`, quote: franceQuote, claims: ['c'] },
    { id: 's2', url: 'http://127.0.0.1:1/x', quote: parisQuote, claims: ['c'] },
  ] })
  assert.equal(result.verdict, 'inconclusive')
  assert.equal(evidence?.confirmedRatio, undefined)
})

test('normalize folds markup, entities, typographic quotes and whitespace', () => {
  assert.equal(normalize('<p>It’s  &quot;A&quot;\n<b>B</b></p>'), 'it\'s "a" b')
})

test('normalize drops Markdown code and emphasis marks and keeps link text (real cases from held research Works)', () => {
  // The Worker read pages as Markdown; the page text is rendered, so the marks must not matter.
  assert.equal(normalize('the `"input"` field'), normalize('the "input" field'))
  assert.equal(normalize('**bold** and *italic* and __strong__ and _em_'), 'bold and italic and strong and em')
  assert.equal(normalize('see [the guide](https://example.com/a_b?x=1) now'), 'see the guide now')
  assert.equal(normalize('[`fetch`](https://example.com) returns **`ok`**'), 'fetch returns ok')
})

test('normalize finds a quote whose punctuation follows a link (France, Wikipedia)', () => {
  const page = '<p>Its capital, largest city and main cultural and economic centre is <a href="/wiki/Paris">Paris</a>, with a metropolitan population of over 13 million.</p>'
  const quote = 'Its capital, largest city and main cultural and economic centre is Paris, with a metropolitan population of over 13 million.'
  assert.ok(normalize(page).includes(normalize(quote)))
})

test('normalize finds a quote that ends a link before a full stop (Paris, Wikipedia)', () => {
  const page = "<p>As the capital of France, Paris is the seat of France's national government<a href=\"#cite\">.</a> As the capital of France, Paris is the seat of France's <a href=\"/wiki/Government\">national government</a>.</p>"
  const quote = "As the capital of France, Paris is the seat of France's national government."
  assert.ok(normalize(page).includes(normalize(quote)))
  assert.ok(normalize("see (<a href=\"/x\">this</a> ) one").includes(normalize('see (this) one')))
})

test('normalize treats inline elements as no word boundary (RFC 9113, RFC 9001)', () => {
  const tcp = '<p>HTTP/2 runs over a TCP connection\n (<span>[<a href="#RFC0793" class="xref">TCP</a>]</span>).</p>'
  assert.ok(normalize(tcp).includes(normalize('runs over a TCP connection ([TCP]).')))
  const alpn = '<p>negotiated <span>in TLS</a></span> [<a href="#TLS-ALPN" class="xref">TLS-ALPN</a>].</p>'
  assert.ok(normalize(alpn).includes(normalize('in TLS [TLS-ALPN].')))
  const quic = '<p>TLS 1.3 <span>[<a href="#TLS13" class="xref">TLS13</a>]</span> is used with QUIC.</p>'
  assert.ok(normalize(quic).includes(normalize('TLS 1.3 [TLS13] is used with QUIC.')))
})

test('normalize keeps block elements as word boundaries', () => {
  assert.ok(!normalize('<p>alpha</p><p>beta</p>').includes(normalize('alphabeta')))
  assert.ok(normalize('<p>alpha</p><p>beta</p>').includes(normalize('alpha beta')))
})

test('normalize reads a Markdown table cell separator as whitespace (France infobox)', () => {
  const page = '<tr><th>Capital and largest city</th><td><a href="/wiki/Paris">Paris</a> (de facto)</td></tr>'
  const quote = 'Capital and largest city | Paris (de facto)'
  assert.ok(normalize(page).includes(normalize(quote)))
})

test('normalize does not find a quote with different words', () => {
  const page = '<p>The capital is <a href="/wiki/Paris">Paris</a>, with many people.</p>'
  assert.ok(!normalize(page).includes(normalize('The capital is Lyon, with many people.')))
})

test('a quote that differs from the page only in Markdown formatting is found', async () => {
  const { result } = await cite({ sources: [{ id: 's1', url: `${base}/article`, quote: '**System** verifies [`citations`](https://example.com/x) _exactly_', claims: ['c'] }] })
  assert.equal(result.verdict, 'pass', result.reason)
})

const twoOfThree = () => ({ sources: [
  { id: 's1', url: `${base}/article`, quote: 'system verifies citations', claims: ['c'] },
  { id: 's2', url: `${base}/article`, quote: 'exactly & carefully', claims: ['c'] },
  { id: 's3', url: `${base}/gone`, quote: 'a quote on a missing page', claims: ['c'] },
] })
const criteriaWith = (extra: Record<string, unknown>) => ({ name: 'c', minSources: 1, minQuoteChars: 8, fetchTimeoutMs: 20_000, maxBytes: 1 << 20, ...extra })

test('2 of 3 confirmed passes at the default 0.5, naming the unconfirmed source; evidence has ratio and threshold', async () => {
  const { result, evidence } = await cite(twoOfThree())
  assert.equal(result.verdict, 'pass', result.reason)
  assert.match(result.reason, /2 of 3/)
  assert.match(result.reason, /s3 \(HTTP 404, quote unreadable\)/)
  assert.doesNotMatch(result.reason, /s1|s2/)
  assert.equal(evidence?.minConfirmedRatio, 0.5)
  assert.equal(evidence?.confirmedRatio, 2 / 3)
})

test('2 of 3 confirmed is inconclusive at 1.0, and the reason still lists the unconfirmed source', async () => {
  const { result, evidence } = await cite(twoOfThree(), criteriaWith({ minConfirmedRatio: 1 }))
  assert.equal(result.verdict, 'inconclusive')
  assert.match(result.reason, /s3/)
  assert.equal(evidence?.minConfirmedRatio, 1)
})

test('criteria pinned without minConfirmedRatio keep the old rule: every quote must be found', async () => {
  assert.equal((await cite(twoOfThree(), criteriaWith({}))).result.verdict, 'inconclusive')
  const { result, evidence } = await cite({ sources: twoOfThree().sources.slice(0, 2) }, criteriaWith({}))
  assert.equal(result.verdict, 'pass', result.reason)
  assert.equal(evidence?.minConfirmedRatio, 1)
})

test('the reason names every unconfirmed source with why: quote not found, or fetch failed', async () => {
  const { result } = await cite({ sources: [
    { id: 'ok', url: `${base}/article`, quote: 'system verifies citations', claims: ['c'] },
    { id: 'nf', url: `${base}/article`, quote: 'a sentence the page never says', claims: ['c'] },
    { id: 'ff', url: 'http://127.0.0.1:1/x', quote: 'system verifies citations', claims: ['c'] },
  ] }, criteriaWith({ minConfirmedRatio: 0.3 }))
  assert.equal(result.verdict, 'pass', result.reason)
  assert.match(result.reason, /nf \(HTTP 200, quote not found\)/)
  assert.match(result.reason, /ff \(fetch failed: /)
})

test('a ratio outside 0 to 1 is not valid criteria', () => {
  assert.equal(citationCriteriaSchema.safeParse(criteriaWith({ minConfirmedRatio: 1.5 })).success, false)
  assert.equal(citationCriteriaSchema.safeParse(criteriaWith({ minConfirmedRatio: 0 })).success, true)
})

// 2026-11-07: Xvfb processes leaked by a Worker's own tests held a finished attempt "running" for 33 min.
/** The tree content of a stored `git-tree@1` Artifact. */
const treeOf = (artifacts: Artifacts, treeId: string) => {
  const read = artifacts.get(treeId)
  assert.ok(read.state === 'stored')
  return read.envelope.content as GitTreeContent
}

// build must pass with only the new tests in place; unit runs them and must fail; docs is not touched.
const RED = `checks:
  - name: build
    run: grep -qx good value.txt
    red: pass
  - name: unit
    run: "! test -f tests/new.sh || sh tests/new.sh"
  - name: docs
    run: "true"
    paths: [docs/**]
    red: pass
`

test('red-v1: the tests step\'s change passes when every red: pass check passes and a red: fail check fails', async () => {
  const artifacts = store()
  const repository = repo(RED)
  const { task, tree } = await taskOn(artifacts, repository)
  const verifier = requiredChecks(artifacts, processSpawner)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'red-v1', input: task, operatorId: 't' })
  const verify = (subject: string) => verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'red', capability: 'code.required-checks', subject, criteria })

  const red = await verify(await change(artifacts, repository, tree.commit, { 'tests/new.sh': 'grep -qx better value.txt\n' }))
  assert.equal(red.verdict, 'pass', red.reason)
  assert.match(red.reason, /failed as it should, and passes on the base: unit \(exit 1\)/)
  assert.match(red.reason, /passed: build/)
  assert.match(red.reason, /skipped: docs/)
  assert.equal(red.evidence.length, 4, 'build and unit on the change, then on the base, where unit passes')

  const proves = await verify(await change(artifacts, repository, tree.commit, { 'tests/new.sh': 'true\n' }))
  assert.equal(proves.verdict, 'fail')
  assert.match(proves.reason, /no check with red: fail failed/)

  const broken = await verify(await change(artifacts, repository, tree.commit, { 'tests/new.sh': 'false\n', 'value.txt': 'bad\n' }))
  assert.equal(broken.verdict, 'fail')
  assert.match(broken.reason, /must pass with only the new tests: build \(exit 1\)/)

  // The same change under the ordinary criteria: a failing unit check is a failure.
  const ordinary = await verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: task, operatorId: 't' })
  const plain = await verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'checks', capability: 'code.required-checks', subject: await change(artifacts, repository, tree.commit, { 'tests/new.sh': 'false\n' }), criteria: ordinary })
  assert.equal(plain.verdict, 'fail')
  await assert.rejects(verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: (await taskOn(artifacts, repo('checks:\n  - name: a\n    run: "true"\n    red: maybe\n'))).task, operatorId: 't' }), /is invalid/)
})

test('red-v1: a red: fail check that fails on the base too is not red: alone, the verdict is inconclusive', async () => {
  const artifacts = store()
  const repository = repo('checks:\n  - name: build\n    run: "true"\n    red: pass\n  - name: unit\n    run: test -f never-there\n')
  const { task, tree } = await taskOn(artifacts, repository)
  const verifier = requiredChecks(artifacts, processSpawner)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'red-v1', input: task, operatorId: 't' })
  const result = await verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'red', capability: 'code.required-checks', subject: await change(artifacts, repository, tree.commit, { 'tests/new.sh': 'false\n' }), criteria })
  assert.equal(result.verdict, 'inconclusive', result.reason)
  assert.match(result.reason, /fails on the base .* too/)
  assert.equal(result.evidence.length, 7, 'build and unit on the change and base, then unit on the change and build and unit on the base')
})

/** Run red-v1 with a passing build and a unit check against a real tests-step change. */
async function redFailure(run: string, files: Record<string, string>, timeoutSeconds = 10, extra: Record<string, string> = {}) {
  const artifacts = store()
  const repository = repo(`checks:
  - name: build
    run: "true"
    red: pass
  - name: unit
    run: ${JSON.stringify(run)}
    red: fail
    timeoutSeconds: ${timeoutSeconds}
`, extra)
  const { task, tree } = await taskOn(artifacts, repository)
  const verifier = requiredChecks(artifacts, processSpawner)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'red-v1', input: task, operatorId: 't' })
  const subject = await change(artifacts, repository, tree.commit, files)
  return verifier.verify({ workId: 'w', attemptId: 'a', stepId: 'red', capability: 'code.required-checks', subject, criteria })
}

test('red-v1: a timeout without named new tests is not red', { timeout: 60_000 }, async () => {
  const result = await redFailure('! test -f tests/new.sh || sh tests/new.sh', { 'tests/new.sh': 'sleep 30\n' }, 1)
  assert.equal(result.verdict, 'fail', result.reason)
  assert.match(result.reason, /timed out after 1 s/)
  assert.match(result.reason, /not a red failure/)
  assert.equal(result.evidence.length, 2, 'reject before running the base: only build and unit on the change')
})

test('red-v1: a killed check without named new tests is not red', async () => {
  const result = await redFailure('! test -f tests/new.sh || sh tests/new.sh', { 'tests/new.sh': 'kill -9 $$\n' })
  assert.equal(result.verdict, 'fail', result.reason)
  assert.match(result.reason, /not a red failure/)
})

test('red-v1: a timeout naming only new test files is red', { timeout: 60_000 }, async () => {
  const hanging = "import { test } from 'node:test'\ntest('first', () => {})\ntest('waits forever', () => new Promise(() => { setInterval(() => {}, 1000) }))\n"
  const result = await redFailure('test ! -f hangs.test.mjs || node --test hangs.test.mjs', { 'hangs.test.mjs': hanging }, 3)
  assert.equal(result.verdict, 'pass', result.reason)
  assert.match(result.reason, /hangs\.test\.mjs/)
})

test('red-v1: failing tests in new test files are red', async () => {
  const failing = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('adds', () => { assert.equal(1 + 1, 3) })\n"
  const result = await redFailure('test ! -f new.test.mjs || node --test', { 'new.test.mjs': failing })
  assert.equal(result.verdict, 'pass', result.reason)
  assert.match(result.reason, /new\.test\.mjs/)
})

test('red-v1: failures only in files the tests step did not write are not red', async () => {
  const old = "import { test } from 'node:test'\nimport { existsSync } from 'node:fs'\ntest('old', () => { if (existsSync('flag.txt')) throw new Error('boom') })\n"
  const passing = "import { test } from 'node:test'\ntest('new', () => {})\n"
  const result = await redFailure('node --test', { 'flag.txt': 'trigger\n', 'new.test.mjs': passing }, 10, { 'old.test.mjs': old })
  assert.equal(result.verdict, 'fail', result.reason)
  assert.match(result.reason, /old\.test\.mjs/)
  assert.match(result.reason, /not a red failure/)
})

test('red-v1: an inconclusive check that times out on the change re-run is not red', { timeout: 60_000 }, async () => {
  // The first change and base runs fail normally. Only the change's re-run hangs.
  const run = 'n=$(cat "$HOME/n" 2>/dev/null || echo 0); echo $((n+1)) > "$HOME/n"; if [ "$n" -eq 2 ]; then sleep 30; fi; exit 1'
  const result = await redFailure(run, { 'tests/new.sh': 'false\n' }, 1)
  assert.equal(result.verdict, 'fail', result.reason)
  assert.match(result.reason, /timed out after 1 s/)
  assert.match(result.reason, /not a red failure/)
  assert.equal(result.evidence.length, 5, 'change, base with prerequisites, then unit on the change; no second base run')
})

test('tests-frozen-v1: implement may add files, but not change one the tests step changed', async () => {
  const artifacts = store()
  const repository = repo(CHECKS)
  const { task, tree } = await taskOn(artifacts, repository)
  const verifier = requiredChecks(artifacts, processSpawner)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'tests-frozen-v1', input: task, operatorId: 't' })
  const tests = await change(artifacts, repository, tree.commit, { 'tests/a.test': 'a\n', 'value.txt': 'good\nand more\n' })
  const testsCommit = treeOf(artifacts, tests).commit
  const verify = (subject: string, inputs?: Record<string, string>) => verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'tests-frozen', capability: 'code.required-checks', subject, criteria, ...(inputs ? { inputs } : {}) })

  const kept = await verify(await change(artifacts, repository, testsCommit, { 'src.txt': 'code\n', 'tests/b.test': 'another new test\n' }), { tests })
  assert.equal(kept.verdict, 'pass', kept.reason)
  assert.equal(kept.evidence.length, 1)
  const run = artifacts.get(kept.evidence[0]!)
  assert.equal(run.state === 'stored' && run.envelope.kind, 'check-run')

  const rewritten = await verify(await change(artifacts, repository, testsCommit, { 'src.txt': 'code\n', 'tests/a.test': 'rewritten\n', 'value.txt': 'good\n' }), { tests })
  assert.equal(rewritten.verdict, 'fail')
  assert.match(rewritten.reason, /changed what the tests step wrote: tests\/a\.test, value\.txt/)

  const missing = await verify(tests)
  assert.equal(missing.verdict, 'error')
  assert.match(missing.reason, /input "tests"/)
})

/** Assert the pending public API inside each test, keeping unrelated verifier tests runnable. */
async function restoration() {
  const work = await import('@system/work')
  assert.ok('restoreFiles' in work && typeof work.restoreFiles === 'function', '@system/work must export restoreFiles')
  return work.restoreFiles as (repository: string, change: GitTreeContent, from: GitTreeContent, message: string) => Promise<GitTreeContent>
}

test('restoreFiles puts back what the tests step wrote, and tests-frozen-v1 then passes', async () => {
  const restoreFiles = await restoration()
  const artifacts = store()
  const repository = repo(CHECKS)
  const { task, tree } = await taskOn(artifacts, repository)
  const verifier = requiredChecks(artifacts, processSpawner)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'tests-frozen-v1', input: task, operatorId: 't' })
  const tests = await change(artifacts, repository, tree.commit, { 'tests/a.test': 'a\n', 'value.txt': 'good\nand more\n' })
  const testsTree = treeOf(artifacts, tests)
  const implement = await change(artifacts, repository, testsTree.commit, { 'src.txt': 'code\n', 'tests/a.test': 'rewritten\n', 'value.txt': 'good\n', 'tests/b.test': 'new\n' })
  const verify = (subject: string) => verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'tests-frozen', capability: 'code.required-checks', subject, criteria, inputs: { tests } })
  assert.equal((await verify(implement)).verdict, 'fail')

  const restored = await restoreFiles(repository, treeOf(artifacts, implement), testsTree, 'restore frozen files')
  const show = (path: string) => execFileSync('git', ['-C', repository, 'show', `${restored.commit}:${path}`], { encoding: 'utf8' })
  assert.equal(show('tests/a.test'), 'a\n')
  assert.equal(show('value.txt'), 'good\nand more\n')
  assert.equal(show('src.txt'), 'code\n')
  assert.equal(show('tests/b.test'), 'new\n')
  assert.equal(restored.parent, testsTree.commit)
  assert.equal(execFileSync('git', ['-C', repository, 'rev-parse', `${restored.commit}^`], { encoding: 'utf8' }).trim(), testsTree.commit)
  const restoredId = (await artifacts.put({ ...GIT_TREE_KIND, content: restored, classification: 'local-private', producer })).id
  const result = await verify(restoredId)
  assert.equal(result.verdict, 'pass', result.reason)
})

test('restoreFiles deletes a file the tests step deleted and implement re-created', async () => {
  const restoreFiles = await restoration()
  const artifacts = store()
  const repository = repo(CHECKS)
  const { tree } = await taskOn(artifacts, repository)
  const tests = treeOf(artifacts, await change(artifacts, repository, tree.commit, { 'value.txt': null }))
  const implement = treeOf(artifacts, await change(artifacts, repository, tests.commit, { 'value.txt': 're-created\n', 'src.txt': 'code\n' }))
  const restored = await restoreFiles(repository, implement, tests, 'restore deletion')
  assert.equal(execFileSync('git', ['-C', repository, 'ls-tree', restored.commit, '--', 'value.txt'], { encoding: 'utf8' }), '')
  assert.equal(execFileSync('git', ['-C', repository, 'show', `${restored.commit}:src.txt`], { encoding: 'utf8' }), 'code\n')
  assert.equal(restored.parent, tests.commit)
})

test('restoreFiles keeps the same commit when the frozen files are unchanged', async () => {
  const restoreFiles = await restoration()
  const artifacts = store()
  const repository = repo(CHECKS)
  const { tree } = await taskOn(artifacts, repository)
  const tests = treeOf(artifacts, await change(artifacts, repository, tree.commit, { 'tests/a.test': 'a\n' }))
  const implement = treeOf(artifacts, await change(artifacts, repository, tests.commit, { 'src.txt': 'code\n' }))
  const restored = await restoreFiles(repository, implement, tests, 'nothing to restore')
  assert.equal(restored.commit, implement.commit)
  assert.deepEqual(restored, implement)
})

test('a check that leaves an Xvfb or Chrome behind fails, naming it; the leftover is stopped', async () => {
  const artifacts = store()
  const repository = repo('checks:\n  - name: leaky\n    run: ln -s "$(command -v sleep)" Xvfb && setsid ./Xvfb 120 >/dev/null 2>&1 & until [ "$(cat /proc/$!/comm 2>/dev/null)" = Xvfb ]; do sleep 0.05; done\n  - name: clean\n    run: echo fine\n')
  const { task, treeId } = await taskOn(artifacts, repository)
  const verifier = requiredChecks(artifacts, processSpawner)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: task, operatorId: 't' })
  // The leftover is known by the pid the verifier names, never by its name: this machine is shared.
  let leftover = 0
  try {
    const result = await verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'checks', capability: 'code.required-checks', subject: treeId, criteria })
    assert.equal(result.verdict, 'fail')
    assert.match(result.reason, /leaky \(left running: Xvfb pid \d+\)/)
    leftover = Number(/Xvfb pid (\d+)/.exec(result.reason)![1])
    assert.doesNotMatch(result.reason, /clean/)
    const run = artifacts.get(result.evidence[0]!)
    assert.match(JSON.stringify(run.state === 'stored' && (run.envelope.content as { leftovers: string[] }).leftovers), /Xvfb pid \d+/)
    // SIGKILL is sent; the process is gone once init has reaped it, which a loaded machine takes a while to do.
    for (const end = Date.now() + 30_000; Date.now() < end;) {
      try { process.kill(leftover, 0) } catch { break }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.throws(() => process.kill(leftover, 0), 'the leftover is stopped')
  } finally {
    if (leftover) try { process.kill(leftover, 'SIGKILL') } catch { /* stopped */ }
  }
})

/** A repository whose checks are `checks`, with `files` beside them (package.json, test files), and a change on it; returns the verdict. */
/** `added` goes into the change itself, not the base: a check on it that fails the change passes the base. */
async function verdictOf(checks: string, files: Record<string, string>, added: Record<string, string> = {}) {
  const artifacts = store()
  const repository = repo(checks)
  for (const [path, text] of Object.entries(files)) writeFileSync(join(repository, path), text)
  execFileSync('git', ['-C', repository, 'add', '.'])
  if (Object.keys(files).length) execFileSync('git', ['-C', repository, 'commit', '--quiet', '-m', 'files'], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  const { task, tree } = await taskOn(artifacts, repository)
  const verifier = requiredChecks(artifacts, processSpawner)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: task, operatorId: 't' })
  const subject = await change(artifacts, repository, tree.commit, { 'NOTES.md': 'added\n', ...added })
  return verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'checks', capability: 'code.required-checks', subject, criteria })
}

test('the checks run on the Node the repository asks for, whatever Node is first on the Host\'s PATH', async () => {
  // A Node 22 first on PATH, as the Host had twice.
  const old = mkdtempSync(join(root, 'node22-'))
  writeFileSync(join(old, 'node'), '#!/bin/sh\necho v22.0.0\nexit 0\n', { mode: 0o755 })
  const path = process.env.PATH
  process.env.PATH = `${old}:${path}`
  try {
    const result = await verdictOf('checks:\n  - name: node\n    run: test "$(node -p process.versions.node | cut -d. -f1)" = 24\n', { 'package.json': '{ "engines": { "node": ">=24.9.0" } }\n' })
    assert.equal(result.verdict, 'pass', result.reason)
  } finally {
    process.env.PATH = path
  }
})

test('a failed check says in one line which check, which test and its first error line', async () => {
  const failing = "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\ntest('adds', () => { assert.equal(1 + 1, 3) })\ntest('fine', () => {})\n"
  const result = await verdictOf('checks:\n  - name: unit\n    run: test ! -f adds.test.mjs || node --test adds.test.mjs\n', {}, { 'adds.test.mjs': failing })
  assert.equal(result.verdict, 'fail')
  assert.equal(result.reason, 'failed: unit: adds.test.mjs "adds": Expected values to be strictly equal: 2 !== 3')
})

test('a timed-out check names the test that was running', { timeout: 180_000 }, async () => {
  const hanging = "import { test } from 'node:test'\ntest('first', () => {})\ntest('waits forever', () => new Promise(() => { setInterval(() => {}, 1000) }))\n"
  const result = await verdictOf('checks:\n  - name: unit\n    run: test ! -f hangs.test.mjs || node --test hangs.test.mjs\n    timeoutSeconds: 20\n', {}, { 'hangs.test.mjs': hanging })
  assert.equal(result.verdict, 'fail')
  assert.match(result.reason, /^failed: unit: timed out after 20 s while running hangs\.test\.mjs/)
})

test('engines.node ranges: the comparators package.json uses', async () => {
  const { satisfies } = await import('../src/reasons.ts')
  assert.deepEqual(['>=24.9.0', '^24.1.0', '24', '>=22 <24', '24.21.0'].map((range) => satisfies('v24.21.0', range)), [true, true, true, false, true])
  assert.equal(satisfies('22.12.0', '>=24.9.0'), false)
})

test('a check with paths runs only when the change touches one of them, and the verdict lists what ran and what was skipped', async () => {
  const artifacts = store()
  const repository = repo('checks:\n  - name: always\n    run: "true"\n  - name: packages\n    run: "true"\n    paths: ["packages/**"]\n')
  const { task, tree } = await taskOn(artifacts, repository)
  const verifier = requiredChecks(artifacts, processSpawner)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: task, operatorId: 't' })
  const verify = (subject: string) => verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'checks', capability: 'code.required-checks', subject, criteria })

  const docs = await verify(await change(artifacts, repository, tree.commit, { 'docs/note.md': 'a note\n' }))
  assert.equal(docs.verdict, 'pass', docs.reason)
  assert.match(docs.reason, /run: always [\d.]+ s; skipped: packages$/)
  assert.equal(docs.evidence.length, 1, 'a skipped check has no run')
  const code = await verify(await change(artifacts, repository, tree.commit, { 'packages/a/index.ts': 'export {}\n' }))
  assert.match(code.reason, /run: always [\d.]+ s, packages [\d.]+ s$/)
  assert.equal(code.evidence.length, 2)
  await assert.rejects(verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: (await taskOn(artifacts, repo('checks:\n  - name: a\n    run: "true"\n    paths: []\n'))).task, operatorId: 't' }), /is invalid/)
})

test('a reopened step\'s change is checked by the files that differ from the Task\'s base, not from the previous attempt\'s change', async () => {
  const artifacts = store()
  const repository = repo('checks:\n  - name: always\n    run: "true"\n  - name: packages\n    run: "true"\n    paths: ["packages/**"]\n')
  const { task, tree } = await taskOn(artifacts, repository)
  const first = await change(artifacts, repository, tree.commit, { 'packages/a/index.ts': 'export {}\n' })
  const firstRead = artifacts.get(first)
  assert.ok(firstRead.state === 'stored')
  const firstCommit = (firstRead.envelope.content as GitTreeContent).commit
  const second = await change(artifacts, repository, firstCommit, { 'docs/note.md': 'n\n' })
  const verifier = requiredChecks(artifacts, processSpawner)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: task, operatorId: 't' })
  const result = await verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'checks', capability: 'code.required-checks', subject: second, criteria })
  assert.equal(result.verdict, 'pass', result.reason)
  assert.match(result.reason, /run: always [\d.]+ s, packages [\d.]+ s$/)
})

test('a check that failed earlier in the Work runs again whatever the diff selects', async () => {
  const artifacts = store()
  const repository = repo('checks:\n  - name: always\n    run: "true"\n  - name: gate\n    run: test -f ok.txt\n    paths: ["src/**"]\n')
  writeFileSync(join(repository, 'ok.txt'), 'ok\n')
  execFileSync('git', ['-C', repository, 'add', 'ok.txt'])
  execFileSync('git', ['-C', repository, 'commit', '--quiet', '-m', 'add gate fixture'], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  const { task, tree } = await taskOn(artifacts, repository)
  const verifier = requiredChecks(artifacts, processSpawner)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: task, operatorId: 't' })
  const bad = await verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'checks', capability: 'code.required-checks', subject: await change(artifacts, repository, tree.commit, { 'src/a.ts': 'x\n', 'ok.txt': null }), criteria })
  assert.equal(bad.verdict, 'fail')
  assert.match(bad.reason, /gate/)
  const docsOnly = await change(artifacts, repository, tree.commit, { 'docs/n.md': 'n\n', 'ok.txt': 'ok\n' })
  const withoutEarlier = await verifier.verify({ workId: 'w', attemptId: `${RUN}-b`, stepId: 'checks', capability: 'code.required-checks', subject: docsOnly, criteria })
  assert.equal(withoutEarlier.verdict, 'pass', withoutEarlier.reason)
  assert.match(withoutEarlier.reason, /run: always [\d.]+ s; skipped: gate$/)

  const retryRequest = { workId: 'w', attemptId: `${RUN}-c`, stepId: 'checks', capability: 'code.required-checks', subject: docsOnly, criteria, earlier: bad.evidence }
  const withEarlier = await verifier.verify(retryRequest)
  assert.equal(withEarlier.verdict, 'pass', withEarlier.reason)
  assert.match(withEarlier.reason, /run: always [\d.]+ s, gate [\d.]+ s \(failed earlier\)$/)
  assert.equal(withEarlier.evidence.length, 2)

  const passingEvidence = await verifier.verify({ workId: 'w', attemptId: `${RUN}-d`, stepId: 'checks', capability: 'code.required-checks', subject: docsOnly, criteria })
  const passEarlierRequest = { workId: 'w', attemptId: `${RUN}-e`, stepId: 'checks', capability: 'code.required-checks', subject: docsOnly, criteria, earlier: passingEvidence.evidence }
  const passEarlier = await verifier.verify(passEarlierRequest)
  assert.match(passEarlier.reason, /run: always [\d.]+ s; skipped: gate$/)
})

test('System\'s own checks: a change to docs alone runs only docs; code, tests or the Charter run the main checks; the web Runtime adds web', async () => {
  const { readFileSync } = await import('node:fs')
  const { parse } = await import('yaml')
  const { checksFileSchema, selected } = await import('../src/checks.ts')
  const own = checksFileSchema.parse(parse(readFileSync(new URL('../../../.system/checks.yaml', import.meta.url), 'utf8')))
  const run = (touched: string[]) => own.checks.filter((c) => selected(c, touched)).map((c) => c.name)
  assert.deepEqual(run(['docs/architecture/host.md', 'PLAN.md']), ['docs'])
  const all = own.checks.map((c) => c.name)
  const main = all.filter((name) => name !== 'web')
  for (const file of ['packages/work/src/controller.ts', 'tests/work.test.ts', 'docs/requirements/purpose.md', 'workflows/code-checks.yaml']) assert.deepEqual(run([file]), main, file)
  // The Website Worker's headed-browser tests run only when the web Runtime, its driver, its test or the headed helper change (PLAN WW).
  for (const file of ['packages/web-driver/src/driver.ts', 'packages/web-worker/src/chatgpt.ts', 'tests/chatgpt-web.test.ts', 'test-support/headed.ts']) assert.deepEqual(run([file]), all, file)
  for (const file of ['test-support/fixture.ts', '.system/checks.yaml', 'package.json', 'pnpm-lock.yaml']) assert.deepEqual(run([file]), main, file)
})

test('a commit checked as it is (code-checks.yaml on its own) runs every check, paths or not', async () => {
  const artifacts = store()
  const repository = repo('checks:\n  - name: always\n    run: "true"\n  - name: packages\n    run: "true"\n    paths: ["packages/**"]\n')
  const { task } = await taskOn(artifacts, repository)
  const verifier = requiredChecks(artifacts, processSpawner)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: task, operatorId: 't' })
  const result = await verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'checks', capability: 'code.required-checks', subject: task, criteria })
  assert.equal(result.verdict, 'pass', result.reason)
  assert.match(result.reason, /run: always [\d.]+ s, packages [\d.]+ s$/)
})

test('a release is checked as a change from the running one: the web check runs only when the diff touches its paths; the first install runs every check', async () => {
  const checks = 'checks:\n  - name: always\n    run: "true"\n  - name: web\n    run: "true"\n    paths: ["packages/web-worker/**"]\n'
  const artifacts = store()
  const repository = repo(checks)
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { env, encoding: 'utf8' }).trim()
  const running = git('rev-parse', 'HEAD')
  const commit = (path: string) => {
    mkdirSync(join(repository, path, '..'), { recursive: true })
    writeFileSync(join(repository, path), `${path}\n`)
    git('add', '.')
    git('commit', '--quiet', '-m', path)
    return git('rev-parse', 'HEAD')
  }
  const docs = commit('docs/note.md')
  const worker = commit('packages/web-worker/a.ts')
  const verifier = requiredChecks(artifacts, processSpawner)
  const reason = async (commitId: string, parent?: string) => {
    const tree = { ...(await snapshot(repository, commitId)), ...(parent ? { parent } : {}) }
    const treeId = (await artifacts.put({ ...GIT_TREE_KIND, content: tree, classification: 'local-private', producer })).id
    const task = (await artifacts.put({ ...TASK_KIND, content: { instructions: 'x', base: treeId }, inputs: [treeId], classification: 'local-private', producer })).id
    const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: task, operatorId: 't' })
    const result = await verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'checks', capability: 'code.required-checks', subject: task, criteria })
    assert.equal(result.verdict, 'pass', result.reason)
    return result.reason
  }
  assert.match(await reason(docs, running), /run: always [\d.]+ s; skipped: web$/)
  assert.match(await reason(worker, running), /run: always [\d.]+ s, web [\d.]+ s$/)
  assert.match(await reason(worker, docs), /run: always [\d.]+ s, web [\d.]+ s$/)
  assert.match(await reason(docs), /run: always [\d.]+ s, web [\d.]+ s$/, 'no parent: the whole commit')
})

/** Runs a one-check repository with `checkEnv`; returns the verdict and the check-run content. */
async function withCheckEnv(run: string, checkEnv: Record<string, string>) {
  const artifacts = store()
  const repository = repo(`checks:\n  - name: env\n    run: ${run}\n`)
  const { task, treeId } = await taskOn(artifacts, repository)
  const verifier = requiredChecks(artifacts, processSpawner, Date.now, checkEnv)
  const criteria = await verifier.criteria({ capability: 'code.required-checks', name: 'repo-checks-v1', input: task, operatorId: 't' })
  const result = await verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'checks', capability: 'code.required-checks', subject: treeId, criteria })
  const read = artifacts.get(result.evidence[0]!)
  return { result, run: (read.state === 'stored' ? read.envelope.content : {}) as { stdoutTail: string; checkEnv?: string[] } }
}

test('checkEnv: a check sees a configured variable; HOME is still a fresh directory', async () => {
  const { result, run } = await withCheckEnv('echo "$RUSTUP_HOME $HOME"', { RUSTUP_HOME: '/opt/rustup-test' })
  assert.equal(result.verdict, 'pass', result.reason)
  const [rustup, home] = run.stdoutTail.trim().split(' ')
  assert.equal(rustup, '/opt/rustup-test')
  assert.match(home!, /system-checks-/)
  assert.notEqual(home, process.env.HOME)
})

test('checkEnv: the evidence lists the names and never the values', async () => {
  const { run } = await withCheckEnv('echo ok', { CARGO_HOME: '/secret/value/one', CARGO_TARGET_DIR: '/secret/value/two' })
  assert.deepEqual(run.checkEnv, ['CARGO_HOME', 'CARGO_TARGET_DIR'])
  assert.doesNotMatch(JSON.stringify(run), /secret\/value/)
})

test('checkEnv: HOME, PATH, CI and malformed names are refused', () => {
  for (const bad of ['HOME', 'PATH', 'CI', 'lower', '1X', 'A-B']) {
    assert.equal(checkEnvSchema.safeParse({ [bad]: 'x' }).success, false, bad)
    assert.throws(() => requiredChecks(store(), processSpawner, Date.now, { [bad]: 'x' }), /checkEnv/, bad)
  }
  assert.equal(checkEnvSchema.safeParse({ RUSTUP_HOME: '/x', _A1: 'y' }).success, true)
})

test('a check run is gone when no process has its throwaway HOME; the limit is the verifier\'s maxConcurrentChecks', async () => {
  const limited = requiredChecks(store(), processSpawner, Date.now, {}, 2)
  assert.equal(limited.maxConcurrentChecks, 2)
  assert.equal(requiredChecks(store(), processSpawner).maxConcurrentChecks, undefined)
  assert.equal(await limited.gone!('attempt:never-ran'), true)
})
