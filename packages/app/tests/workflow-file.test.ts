import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { GIT_TREE_KIND, TASK_KIND, gitTreeSchema, snapshot, taskSchema } from '@system/work'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { workflowFile } from '../src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'system-wf-'))
after(() => rmSync(root, { recursive: true, force: true }))

test('a used Workflow file is read at the input Task\'s base commit, else beside the Host\'s code', async () => {
  const { artifacts } = memoryArtifacts({ ...TASK_KIND, content: taskSchema }, { ...GIT_TREE_KIND, content: gitTreeSchema })
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'workflows'), { recursive: true })
  writeFileSync(join(repo, 'workflows', 'code-checks.yaml'), 'at the base commit\n')
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  for (const args of [['init', '--quiet'], ['add', '.'], ['commit', '--quiet', '-m', 'base']]) execFileSync('git', ['-C', repo, ...args], { env })
  const producer = { type: 'operator' as const, ref: 't' }
  const base = (await artifacts.put({ ...GIT_TREE_KIND, content: await snapshot(repo), classification: 'local-private', producer })).id
  const task = (await artifacts.put({ ...TASK_KIND, content: { instructions: 'x', base }, inputs: [base], classification: 'local-private', producer })).id
  // Edited after the commit: the Work reads the file of the commit it changes.
  writeFileSync(join(repo, 'workflows', 'code-checks.yaml'), 'edited since\n')
  assert.equal(workflowFile(artifacts, 'code-checks.yaml', task), 'at the base commit\n')
  const bundled = readFileSync(new URL('../../../workflows/code-checks.yaml', import.meta.url), 'utf8')
  assert.equal(workflowFile(artifacts, 'code-checks.yaml', undefined), bundled)
  assert.equal(workflowFile(artifacts, 'research.yaml', task), readFileSync(new URL('../../../workflows/research.yaml', import.meta.url), 'utf8'), 'not in that commit: the Host\'s own')
  assert.equal(workflowFile(artifacts, 'nope.yaml', task), undefined)
})
