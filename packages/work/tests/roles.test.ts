import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { WorkflowError, parseWorkflow, resolve, type AvailableCapabilities } from '../src/workflow.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const fixture = (name: string) => readFileSync(join(repo, 'workflows', name), 'utf8')
const everything: AvailableCapabilities = {
  workers: new Set(['code-write', 'code.develop', 'code.tests', 'code.docs', 'research', 'web-search', 'tier.standard', 'tier.economy']),
  verifiers: new Set(['code.required-checks', 'research.citation-check']),
  effects: new Set(['git.publish']),
}

function caps(spec: ReturnType<typeof resolve>, id: string): string[] {
  const step = spec.steps.find((candidate) => candidate.id === id)
  assert.ok(step && 'capabilities' in step, `expected ${id} to be a Worker step`)
  return step.capabilities
}

const cases = [
  { file: 'feature.yaml', with: ['plan', 'implement', 'docs'], without: ['tests'] },
  { file: 'feature-research.yaml', with: ['plan', 'implement', 'docs'], without: ['research', 'tests'] },
  { file: 'software-engineering.yaml', with: ['implement'], without: [] },
  { file: 'software-engineering-docs.yaml', with: ['implement'], without: ['docs-impact'] },
  { file: 'hygiene.yaml', with: ['plan', 'implement'], without: ['scout-docs', 'scout-code', 'scout-tree'] },
]

test('code.develop is on the plan, implement and docs steps of the code Workflows, and on no other step', () => {
  for (const { file, with: yes, without: no } of cases) {
    const spec = resolve(parseWorkflow(fixture(file)), everything, fixture)
    for (const id of yes) assert.ok(caps(spec, id).includes('code.develop'), `${file}:${id}`)
    for (const id of no) assert.ok(!caps(spec, id).includes('code.develop'), `${file}:${id}`)
  }
})

test('code-write stays on the steps that write the checkout', () => {
  for (const [file, ids] of [
    ['feature.yaml', ['plan', 'implement']],
    ['feature-research.yaml', ['plan', 'implement']],
    ['software-engineering.yaml', ['implement']],
    ['software-engineering-docs.yaml', ['implement']],
    ['hygiene.yaml', ['plan', 'implement']],
  ] as const) {
    const spec = resolve(parseWorkflow(fixture(file)), everything, fixture)
    for (const id of ids) assert.ok(caps(spec, id).includes('code-write'), `${file}:${id}`)
  }
})

test('the tests step keeps code.tests and never asks for code.develop', () => {
  for (const file of ['feature.yaml', 'feature-research.yaml']) {
    const spec = resolve(parseWorkflow(fixture(file)), everything, fixture)
    assert.deepEqual(caps(spec, 'tests'), ['code.tests', 'tier.standard'])
  }
})

test('Claude-like and Codex-like Accounts split the steps', () => {
  const claude = new Set(['code-write', 'code.develop', 'code.docs', 'research', 'web-search', 'tier.standard', 'tier.economy'])
  const codex = new Set(['code-write', 'code.tests', 'tier.standard', 'tier.economy'])
  for (const file of ['feature.yaml', 'feature-research.yaml']) {
    const spec = resolve(parseWorkflow(fixture(file)), everything, fixture)
    const workerSteps = spec.steps.filter((step) => 'capabilities' in step)
    const runnable = (step: (typeof workerSteps)[number], account: Set<string>) => step.capabilities.every((capability) => account.has(capability))
    assert.deepEqual(workerSteps.filter((step) => runnable(step, codex)).map((step) => step.id), ['tests'])
    assert.deepEqual(workerSteps.filter((step) => runnable(step, claude)).map((step) => step.id), workerSteps.filter((step) => step.id !== 'tests').map((step) => step.id))
  }
})

test('a Workflow with a code.develop step is refused when no Worker provides it', () => {
  const available: AvailableCapabilities = {
    workers: new Set(['code-write', 'research', 'web-search', 'tier.standard']),
    verifiers: new Set(['code.required-checks']),
    effects: new Set(['git.publish']),
  }
  assert.throws(
    () => resolve(parseWorkflow(fixture('software-engineering.yaml')), available, fixture),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError)
      assert.deepEqual(error.problems, ['step implement needs Worker capability code.develop, which no enabled Worker provides'])
      return true
    },
  )
})
