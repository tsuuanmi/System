import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { WorkflowError, directTask, parseWorkflow, resolve, type AvailableCapabilities } from '../src/workflow.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const fixture = (name: string) => readFileSync(join(repo, 'workflows', name), 'utf8')

const available: AvailableCapabilities = {
  workers: new Set(['code-write', 'research', 'web-search']),
  verifiers: new Set(['code.required-checks', 'research.citation-check']),
}

const base = `schema: system.workflow/v1
id: demo
version: 1
steps:
`

function problems(yaml: string, caps: AvailableCapabilities = available): string[] {
  try {
    resolve(parseWorkflow(yaml), caps)
  } catch (error) {
    assert.ok(error instanceof WorkflowError, String(error))
    return error.problems
  }
  assert.fail('expected the workflow to be refused')
}

test('both repository Workflow files parse and resolve with the same schema', () => {
  const se = resolve(parseWorkflow(fixture('software-engineering.yaml')), available)
  const research = resolve(parseWorkflow(fixture('research.yaml')), available)
  assert.deepEqual(se.steps.map((s) => s.id), ['implement', 'checks', 'accept'])
  assert.deepEqual(research.steps.map((s) => s.id), ['investigate', 'citations', 'accept'])
  assert.deepEqual(se.workflow, { id: 'software-engineering', version: 1 })
})

test('steps resolve in dependency order, file order among ready steps, with sorted dependsOn', () => {
  const spec = resolve(parseWorkflow(`${base}  - id: c
    dependsOn: [b, a]
    capabilities: [research]
    outputs: [x]
  - id: a
    capabilities: [research]
    outputs: [x]
  - id: b
    capabilities: [research]
    outputs: [x]
`), available)
  assert.deepEqual(spec.steps.map((s) => s.id), ['a', 'b', 'c'])
  assert.deepEqual(spec.steps[2]!.dependsOn, ['a', 'b'])
})

test('a direct Task is one implicit step, with or without an input', () => {
  const withInput = directTask(['code-write'], true, available)
  assert.equal(withInput.steps.length, 1)
  assert.deepEqual(withInput.steps[0], { id: 'task', capabilities: ['code-write'], inputs: { input: '$work.input' }, outputs: ['result'] })
  assert.equal('inputs' in directTask(['code-write'], false, available).steps[0]!, false)
  assert.throws(() => directTask(['flying'], false, available), WorkflowError)
})

test('YAML errors and duplicate keys are refused', () => {
  assert.match(problems('steps: [')[0]!, /not valid YAML/)
  assert.match(problems(`${base}  - id: a\n    capabilities: [research]\n    capabilities: [research]\n    outputs: [x]\n`)[0]!, /not valid YAML/)
})

test('unknown fields, versions and step forms are refused', () => {
  assert.ok(problems(base.replace('system.workflow/v1', 'system.workflow/v2') + '  - id: a\n    capabilities: [research]\n    outputs: [x]\n').length)
  assert.ok(problems(`${base}  - id: a\n    capabilities: [research]\n    outputs: [x]\n    retries: 3\n`).length)
  assert.ok(problems(`${base}  - id: a\n    outputs: [x]\n`).length, 'a step needs one form')
  assert.ok(problems(`${base}  - id: Bad_Id\n    capabilities: [research]\n    outputs: [x]\n`).length)
  assert.ok(problems(`${base.replace('steps:\n', 'steps: []\n')}`).length, 'no steps')
})

test('duplicate steps, unknown and self dependencies are refused', () => {
  assert.deepEqual(problems(`${base}  - id: a\n    capabilities: [research]\n    outputs: [x]\n  - id: a\n    capabilities: [research]\n    outputs: [x]\n`), ['duplicate step a'])
  assert.deepEqual(problems(`${base}  - id: a\n    dependsOn: [ghost]\n    capabilities: [research]\n    outputs: [x]\n`), ['step a depends on unknown step ghost'])
  assert.deepEqual(problems(`${base}  - id: a\n    dependsOn: [a]\n    capabilities: [research]\n    outputs: [x]\n`), ['step a depends on itself'])
})

test('cycles are refused with their path', () => {
  const found = problems(`${base}  - id: a\n    dependsOn: [b]\n    capabilities: [research]\n    outputs: [x]\n  - id: b\n    dependsOn: [a]\n    capabilities: [research]\n    outputs: [x]\n`)
  assert.deepEqual(found, ['cycle: a -> b -> a'])
})

test('a reference must name an output of a step this step depends on', () => {
  const two = (ref: string, dependsOn = '[a]') => `${base}  - id: a\n    capabilities: [research]\n    outputs: [x]\n  - id: b\n    dependsOn: ${dependsOn}\n    capabilities: [research]\n    inputs:\n      in: ${ref}\n    outputs: [y]\n`
  assert.match(problems(two('$steps.a.missing'))[0]!, /step a has no output missing/)
  assert.match(problems(two('$steps.a.x', '[]'))[0]!, /does not depend on a/)
  assert.match(problems(two('$steps.ghost.x'))[0]!, /no step ghost/)
  assert.ok(problems(two('steps.a.x')).length, 'a reference starts with $')
})

test('capabilities no enabled Worker or verifier provides are refused before any Worker runs', () => {
  const none: AvailableCapabilities = { workers: new Set(), verifiers: new Set() }
  const found = problems(fixture('software-engineering.yaml'), none)
  assert.deepEqual(found, [
    'step implement needs Worker capability code-write, which no enabled Worker provides',
    'step checks needs verifier code.required-checks, which no enabled verifier provides',
  ])
})

test('accept must require verify steps it depends on, appear once, and come last', () => {
  const head = `${base}  - id: a\n    capabilities: [research]\n    outputs: [x]\n  - id: v\n    dependsOn: [a]\n    verify:\n      capability: research.citation-check\n      subject: $steps.a.x\n      criteria: c1\n`
  assert.match(problems(`${head}  - id: ok\n    dependsOn: [v]\n    accept:\n      requires: [a]\n`)[0]!, /a, which is not a verify step/)
  assert.match(problems(`${head}  - id: ok\n    dependsOn: [a]\n    accept:\n      requires: [v]\n`)[0]!, /does not depend on it/)
  assert.match(problems(`${head}  - id: ok\n    dependsOn: [v]\n    accept:\n      requires: [v]\n  - id: ok2\n    dependsOn: [v]\n    accept:\n      requires: [v]\n`)[0]!, /at most one accept step/)
  assert.match(problems(`${head}  - id: ok\n    dependsOn: [v]\n    accept:\n      requires: [v]\n  - id: after\n    dependsOn: [ok]\n    capabilities: [research]\n    outputs: [z]\n`).join(';'), /must be last/)
})

test('how dependsOn is written never changes the resolved spec', () => {
  const steps = (deps: string) => `${base}  - id: a\n    capabilities: [research]\n    outputs: [x]\n  - id: b\n    capabilities: [research]\n    outputs: [x]\n  - id: c\n    dependsOn: ${deps}\n    capabilities: [research]\n    outputs: [x]\n`
  assert.deepEqual(resolve(parseWorkflow(steps('[b, a]')), available), resolve(parseWorkflow(steps('[a, b, a]')), available))
})
