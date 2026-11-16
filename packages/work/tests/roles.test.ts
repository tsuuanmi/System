import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Capabilities, type WorkerPort } from '../src/registry.ts'
import { WorkflowError, parseWorkflow, resolve, type AvailableCapabilities } from '../src/workflow.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const fixture = (name: string) => readFileSync(join(repo, 'workflows', name), 'utf8')
const everything: AvailableCapabilities = {
  workers: new Set(['repo.read', 'repo.write', 'develop.implement', 'web.search', 'web.browse', 'tier.standard', 'tier.economy']),
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

test('develop.implement is on the plan and implement steps of the code Workflows, and on no other step', () => {
  for (const { file, with: yes, without: no } of cases) {
    const spec = resolve(parseWorkflow(fixture(file)), everything, fixture)
    for (const id of yes) assert.ok(caps(spec, id).includes('develop.implement'), `${file}:${id}`)
    for (const id of no) assert.ok(!caps(spec, id).includes('develop.implement'), `${file}:${id}`)
  }
})

test('repo.write stays on the steps that write the checkout', () => {
  for (const [file, ids] of [
    ['develop.yaml', ['implement']],
    ['hygiene.yaml', ['plan', 'implement']],
  ] as const) {
    const spec = resolve(parseWorkflow(fixture(file)), everything, fixture)
    for (const id of ids) assert.ok(caps(spec, id).includes('repo.write'), `${file}:${id}`)
  }
})

test('no shipped Workflow outputs a checkout without repo.write', () => {
  const available = {
    ...everything,
    workers: new Set([...everything.workers, 'review.second-opinion', 'brainstorm.idea-a', 'brainstorm.idea-b', 'brainstorm.synthesis']),
  }
  for (const file of readdirSync(join(repo, 'workflows')).filter((name) => name.endsWith('.yaml'))) {
    const spec = resolve(parseWorkflow(fixture(file)), available, fixture)
    for (const step of spec.steps) {
      if ('capabilities' in step && step.outputs.includes('checkout')) {
        assert.ok(step.capabilities.includes('repo.write'), `${file}:${step.id}`)
      }
    }
  }
})

test('a Workflow with a develop.implement step is refused when no Worker provides it', () => {
  const available: AvailableCapabilities = {
    workers: new Set(['repo.write', 'web.search', 'tier.standard']),
    verifiers: new Set(['code.required-checks']),
    effects: new Set(['git.publish']),
  }
  assert.throws(
    () => resolve(parseWorkflow(fixture('develop.yaml')), available, fixture),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError)
      assert.deepEqual(error.problems, ['step implement needs Worker capability develop.implement, which no enabled Worker provides'])
      return true
    },
  )
})


test('research investigate needs web.search, prefers web.browse and resolves without the role', () => {
  const spec = resolve(parseWorkflow(fixture('research.yaml')), { ...everything, workers: new Set(['web.search', 'tier.standard']) }, fixture)
  const step = spec.steps.find((s) => s.id === 'investigate')!
  assert.equal(Reflect.get(step, 'prefer'), 'web.browse')
  assert.deepEqual(caps(spec, 'investigate'), ['web.search', 'tier.standard'])
  assert.deepEqual(Reflect.get(step, 'retry'), { onFail: ['investigate'], max: 1 })
})

test('research-source investigate needs web.search and repo.read and has no prefer', () => {
  const spec = resolve(parseWorkflow(fixture('research-source.yaml')), everything, fixture)
  assert.deepEqual(caps(spec, 'investigate'), ['web.search', 'repo.read', 'tier.standard'])
  assert.equal(Reflect.get(spec.steps.find((s) => s.id === 'investigate')!, 'prefer'), undefined)
})

test('research-source.yaml routes only to an Account with repo.read', () => {
  const spec = resolve(parseWorkflow(fixture('research-source.yaml')), everything, fixture)
  const needs = caps(spec, 'investigate')
  const worker = (ref: string, capabilities: string[]): WorkerPort => ({ ref, capabilities, run: async () => ({ status: 'succeeded', outputs: {} }) })
  const web = worker('web/fake', ['web.search', 'web.browse', 'tier.standard'])
  const claude = worker('claude-code/fake', ['repo.read', 'repo.write', 'web.search', 'tier.standard'])
  const only = new Capabilities()
  only.registerWorker(web)
  assert.equal(only.routeWorker(needs).selected, undefined)
  const both = new Capabilities()
  both.registerWorker(web)
  both.registerWorker(claude)
  assert.equal(both.routeWorker(needs).selected?.ref, claude.ref)
})

test('no shipped Workflow names a retired capability', () => {
  const retired = /\b(code-write|code\.develop|code\.tests|code\.docs|web-search|research\.web)\b|\[research[,\]]/
  const dirs = ['workflows', 'workflows/experiments']
  for (const dir of dirs) {
    for (const name of readdirSync(join(repo, dir)).filter((n) => n.endsWith('.yaml'))) {
      const lines = readFileSync(join(repo, dir, name), 'utf8').split('\n').filter((l) => /^\s*capabilities:|^\s*prefer:/.test(l))
      for (const line of lines) assert.doesNotMatch(line, retired, `${dir}/${name}: ${line}`)
    }
  }
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
