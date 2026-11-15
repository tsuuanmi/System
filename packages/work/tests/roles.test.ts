import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
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
  { file: 'develop.yaml', with: ['implement'], without: [] },
  { file: 'hygiene.yaml', with: ['plan', 'implement'], without: ['scout-docs', 'scout-code', 'scout-tree'] },
]

test('code.develop is on the plan, tests, implement and docs steps of the code Workflows, and on no other step', () => {
  for (const { file, with: yes, without: no } of cases) {
    const spec = resolve(parseWorkflow(fixture(file)), everything, fixture)
    for (const id of yes) assert.ok(caps(spec, id).includes('code.develop'), `${file}:${id}`)
    for (const id of no) assert.ok(!caps(spec, id).includes('code.develop'), `${file}:${id}`)
  }
})

test('code-write stays on the steps that write the checkout', () => {
  for (const [file, ids] of [
    ['develop.yaml', ['implement']],
    ['hygiene.yaml', ['plan', 'implement']],
  ] as const) {
    const spec = resolve(parseWorkflow(fixture(file)), everything, fixture)
    for (const id of ids) assert.ok(caps(spec, id).includes('code-write'), `${file}:${id}`)
  }
})

test('no shipped Workflow outputs a checkout without code-write', () => {
  const available = {
    ...everything,
    workers: new Set([...everything.workers, 'research.plan', 'research.lane-a', 'research.lane-b', 'research.synthesis', 'review.second-opinion', 'brainstorm.idea-a', 'brainstorm.idea-b', 'brainstorm.synthesis']),
  }
  for (const file of readdirSync(join(repo, 'workflows')).filter((name) => name.endsWith('.yaml'))) {
    const spec = resolve(parseWorkflow(fixture(file)), available, fixture)
    for (const step of spec.steps) {
      if ('capabilities' in step && step.outputs.includes('checkout')) {
        assert.ok(step.capabilities.includes('code-write'), `${file}:${step.id}`)
      }
    }
  }
})

test('a Workflow with a code.develop step is refused when no Worker provides it', () => {
  const available: AvailableCapabilities = {
    workers: new Set(['code-write', 'research', 'web-search', 'tier.standard']),
    verifiers: new Set(['code.required-checks']),
    effects: new Set(['git.publish']),
  }
  assert.throws(
    () => resolve(parseWorkflow(fixture('develop.yaml')), available, fixture),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError)
      assert.deepEqual(error.problems, ['step implement needs Worker capability code.develop, which no enabled Worker provides'])
      return true
    },
  )
})


test('research investigate prefers research.web, keeps required capabilities and resolves without the role', () => {
  assert.equal(everything.workers.has('research.web'), false)
  const spec = resolve(parseWorkflow(fixture('research.yaml')), everything, fixture)
  const step = spec.steps.find((s) => s.id === 'investigate')!
  assert.equal(Reflect.get(step, 'prefer'), 'research.web')
  assert.deepEqual(caps(spec, 'investigate'), ['research', 'web-search', 'tier.standard'])
  assert.deepEqual(Reflect.get(step, 'retry'), { onFail: ['investigate'], max: 1 })
})

test('research investigate instructions state the bracket rule of citations-v3', () => {
  const spec = resolve(parseWorkflow(fixture('research.yaml')), everything, fixture)
  const text = String(Reflect.get(spec.steps.find((s) => s.id === 'investigate')!, 'instructions')).replace(/\s+/g, ' ')
  assert.match(text, /square brackets in the report are only for source ids such as \[s1\]/i)
  assert.match(text, /every \[id\] must be in "?sources"?/)
  assert.match(text, /every source must be cited at least once/)
  assert.match(text, /without square brackets/)
  assert.match(text, /citations-v3/)
})
