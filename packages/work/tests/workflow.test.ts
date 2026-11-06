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
  effects: new Set(['git.publish']),
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
  assert.deepEqual(se.steps.map((s) => s.id), ['implement', 'checks', 'publish', 'accept'])
  assert.deepEqual(research.steps.map((s) => s.id), ['investigate', 'citations', 'accept'])
  assert.deepEqual(se.workflow, { id: 'software-engineering', version: 1 })
})

test('the Brainstorm file: two proposals from the brief alone, then a synthesis of both exact proposals', () => {
  const roles: AvailableCapabilities = { ...available, workers: new Set(['brainstorm.idea-a', 'brainstorm.idea-b', 'brainstorm.synthesis']) }
  const spec = resolve(parseWorkflow(fixture('brainstorm.yaml')), roles)
  const step = (id: string) => spec.steps.find((s) => s.id === id) as { capabilities: string[]; inputs: Record<string, string>; dependsOn?: string[]; outputs: string[]; instructions?: string }
  assert.deepEqual(spec.steps.map((s) => s.id), ['idea-a', 'idea-b', 'synthesis'])
  assert.deepEqual([step('idea-a').inputs, step('idea-b').inputs], [{ brief: '$work.input' }, { brief: '$work.input' }])
  assert.deepEqual(step('idea-b').dependsOn ?? [], [])
  assert.deepEqual(step('synthesis').dependsOn, ['idea-a', 'idea-b'])
  assert.deepEqual(step('synthesis').inputs, { brief: '$work.input', 'proposal-a': '$steps.idea-a.proposal', 'proposal-b': '$steps.idea-b.proposal' })
  assert.deepEqual(['idea-a', 'idea-b', 'synthesis'].map((id) => step(id).capabilities), [['brainstorm.idea-a'], ['brainstorm.idea-b'], ['brainstorm.synthesis']])
  assert.equal(step('idea-a').instructions, step('idea-b').instructions)
  assert.ok(spec.steps.every((s) => 'capabilities' in s), 'no verify, effect or accept step')
  const noCodex = { ...roles, workers: new Set(['brainstorm.idea-a', 'brainstorm.synthesis']) }
  assert.deepEqual(problems(fixture('brainstorm.yaml'), noCodex), ['step idea-b needs Worker capability brainstorm.idea-b, which no enabled Worker provides'])
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
  const none: AvailableCapabilities = { workers: new Set(), verifiers: new Set(), effects: new Set() }
  const found = problems(fixture('software-engineering.yaml'), none)
  assert.deepEqual(found, [
    'step implement needs Worker capability code-write, which no enabled Worker provides',
    'step checks needs verifier code.required-checks, which no enabled verifier provides',
    'step publish needs effect git.publish, which no enabled effect provider offers',
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

const withEffects = available
const publishing = (effect: string, dependsOn = '[checks]') => `${base}  - id: implement
    capabilities: [code-write]
    outputs: [change]
  - id: checks
    dependsOn: [implement]
    verify:
      capability: code.required-checks
      subject: $steps.implement.change
      criteria: c1
  - id: publish
    dependsOn: ${dependsOn}
    effect:
${effect}
`

test('an effect step names its capability, exact subject and the verify steps that must pass first', () => {
  const spec = resolve(parseWorkflow(publishing('      capability: git.publish\n      subject: $steps.implement.change\n      requires: [checks]\n      params:\n        ready: false')), withEffects)
  assert.deepEqual(spec.steps.map((s) => s.id), ['implement', 'checks', 'publish'])
})

test('an effect step is refused when its provider is missing, its requirements are not verify steps it depends on, or it would publish another subject than was verified', () => {
  const ok = '      capability: git.publish\n      subject: $steps.implement.change\n      requires: [checks]'
  assert.deepEqual(problems(publishing(ok), { ...available, effects: new Set() }), ['step publish needs effect git.publish, which no enabled effect provider offers'])
  assert.match(problems(publishing(ok.replace('requires: [checks]', 'requires: [implement]')), withEffects).join(';'), /publish requires implement, which is not a verify step/)
  assert.match(problems(publishing(ok, '[implement]'), withEffects).join(';'), /publish requires checks, but does not depend on it/)
  assert.match(problems(publishing(ok.replace('requires: [checks]', 'requires: []')), withEffects).join(';'), /requires|too_small|>=1/i)
  const twoOutputs = publishing(ok).replace('outputs: [change]', 'outputs: [change, notes]').replace('subject: $steps.implement.change\n      requires', 'subject: $steps.implement.notes\n      requires')
  assert.match(problems(twoOutputs, withEffects).join(';'), /publish publishes \$steps\.implement\.notes, but checks verified \$steps\.implement\.change/)
})
