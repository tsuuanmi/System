/**
 * `release.install-check` (Item fl-5): the `afterInstall` checks of a release commit, run with the installed
 * `system` on PATH; and the checks file that may list them.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { parse } from 'yaml'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { processSpawner } from '../../../test-support/process.ts'
import { CHECKS_KIND, CHECK_RUN_KIND, checkRunSchema, checksFileSchema, checksSchema, parseChecksFile } from '../src/checks.ts'
import { INSTALL_CHECK_V1, installCheck } from '../src/install-check.ts'
import { GIT_TREE_KIND, TASK_KIND, gitTreeSchema, snapshot, taskSchema } from '@system/work'

const root = mkdtempSync(join(tmpdir(), 'system-install-check-'))
after(() => rmSync(root, { recursive: true, force: true }))
const RUN = `i${process.pid}-${Date.now().toString(36)}`
const producer = { type: 'operator' as const, ref: 'tester' }

const store = () => memoryArtifacts(
  { ...TASK_KIND, content: taskSchema }, { ...GIT_TREE_KIND, content: gitTreeSchema }, { ...CHECKS_KIND, content: checksSchema }, { ...CHECK_RUN_KIND, content: checkRunSchema },
).artifacts

/** A fake installed `system` whose `ping` answers and whose `broken` command fails. */
function installBin(): string {
  const bin = mkdtempSync(join(root, 'bin-'))
  writeFileSync(join(bin, 'system'), '#!/bin/sh\n[ "$1" = ping ] && { echo pong; exit 0; }\necho "no such command: $1" >&2\nexit 3\n')
  chmodSync(join(bin, 'system'), 0o755)
  return bin
}

function repo(checksYaml: string): string {
  const dir = mkdtempSync(join(root, 'repo-'))
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  git('init', '--quiet')
  mkdirSync(join(dir, '.system'))
  writeFileSync(join(dir, '.system', 'checks.yaml'), checksYaml)
  git('add', '.')
  git('commit', '--quiet', '-m', 'release')
  return dir
}

async function release(yaml: string) {
  const artifacts = store()
  const repository = repo(yaml)
  const tree = await snapshot(repository)
  const treeId = (await artifacts.put({ ...GIT_TREE_KIND, content: tree, classification: 'local-private', producer })).id
  const task = (await artifacts.put({ ...TASK_KIND, content: { instructions: 'x', base: treeId }, inputs: [treeId], classification: 'local-private', producer })).id
  const verifier = installCheck(artifacts, processSpawner, installBin())
  return { artifacts, verifier, task, treeId, repository, tree }
}

const BASE = 'checks:\n  - name: noop\n    run: "true"\n'

test('a checks file may list afterInstall checks with the schema of checks; without them it parses as before', () => {
  const withIt = checksFileSchema.parse(parse(`${BASE}afterInstall:\n  - name: answers\n    run: system ping\n    timeoutSeconds: 30\n`))
  assert.deepEqual(withIt.afterInstall, [{ name: 'answers', run: 'system ping', timeoutSeconds: 30 }])
  assert.equal(checksFileSchema.parse(parse(BASE)).afterInstall, undefined)
  assert.throws(() => checksFileSchema.parse(parse(`${BASE}afterInstall:\n  - name: Bad Name\n    run: x\n`)))
  const parsed = parseChecksFile(`${BASE}afterInstall:\n  - name: answers\n    run: system ping\n`)
  assert.ok('checks' in parsed && parsed.afterInstall?.[0]?.name === 'answers' && parsed.afterInstall[0].timeoutSeconds === 600)
  assert.ok('checks' in parsed && !('afterInstall' in (parseChecksFile(BASE) as object)))
})

test('criteria pin the afterInstall list of the release commit; none listed is refused', async () => {
  const { artifacts, verifier, task } = await release(`${BASE}afterInstall:\n  - name: answers\n    run: system ping\n`)
  const id = await verifier.criteria({ capability: 'release.install-check', name: INSTALL_CHECK_V1, input: task, operatorId: 't' })
  const read = artifacts.get(id)
  assert.ok(read.state === 'stored')
  assert.deepEqual((read.envelope.content as { checks: { name: string }[] }).checks.map((c) => c.name), ['answers'])
  await assert.rejects(verifier.criteria({ capability: 'release.install-check', name: 'nope-v1', input: task, operatorId: 't' }), /unknown criteria/)
  const none = await release(BASE)
  await assert.rejects(none.verifier.criteria({ capability: 'release.install-check', name: INSTALL_CHECK_V1, input: none.task, operatorId: 't' }), /no afterInstall/)
})

test('the checks run with the installed system on PATH: all passing is pass, one evidence Artifact each', async () => {
  const { artifacts, verifier, task, treeId } = await release(`${BASE}afterInstall:\n  - name: answers\n    run: system ping\n  - name: pongs\n    run: test "$(system ping)" = pong\n`)
  const criteria = await verifier.criteria({ capability: 'release.install-check', name: INSTALL_CHECK_V1, input: task, operatorId: 't' })
  const result = await verifier.verify({ workId: 'w', attemptId: `${RUN}-a`, stepId: 'install', capability: 'release.install-check', subject: treeId, criteria })
  assert.equal(result.verdict, 'pass', result.reason)
  assert.deepEqual([result.subject, result.criteria, result.evidence.length], [treeId, criteria, 2])
  const run = artifacts.get(result.evidence[0]!)
  assert.equal(run.state === 'stored' && (run.envelope.content as { stdoutTail: string }).stdoutTail, 'pong\n')
})

test('a failing check is fail and is named, with its output; the later checks still run', async () => {
  const { artifacts, verifier, task, treeId } = await release(`${BASE}afterInstall:\n  - name: broken-one\n    run: system broken\n  - name: answers\n    run: system ping\n`)
  const criteria = await verifier.criteria({ capability: 'release.install-check', name: INSTALL_CHECK_V1, input: task, operatorId: 't' })
  const result = await verifier.verify({ workId: 'w', attemptId: `${RUN}-b`, stepId: 'install', capability: 'release.install-check', subject: treeId, criteria })
  assert.equal(result.verdict, 'fail')
  assert.match(result.reason, /failed: broken-one/)
  assert.doesNotMatch(result.reason, /answers/)
  assert.equal(result.evidence.length, 2)
  const first = artifacts.get(result.evidence[0]!)
  assert.match(first.state === 'stored' ? (first.envelope.content as { stderrTail: string }).stderrTail : '', /no such command: broken/)
})

test('a commit that cannot be checked out is error', async () => {
  const { verifier, task, treeId, artifacts } = await release(`${BASE}afterInstall:\n  - name: answers\n    run: system ping\n`)
  const criteria = await verifier.criteria({ capability: 'release.install-check', name: INSTALL_CHECK_V1, input: task, operatorId: 't' })
  const tree = artifacts.get(treeId)
  assert.ok(tree.state === 'stored')
  const bad = (await artifacts.put({ ...GIT_TREE_KIND, content: { ...(tree.envelope.content as object), commit: 'f'.repeat(40) } as never, classification: 'local-private', producer })).id
  const result = await verifier.verify({ workId: 'w', attemptId: `${RUN}-c`, stepId: 'install', capability: 'release.install-check', subject: bad, criteria })
  assert.equal(result.verdict, 'error')
})

// Item fl-6b restores the test that this repository's .system/checks.yaml lists the five afterInstall checks, together with the block, after this release (Escaped defect 8).
