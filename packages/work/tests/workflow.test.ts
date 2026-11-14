import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { WorkflowError, directTask, parseWorkflow, resolve, type AvailableCapabilities } from '../src/workflow.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const fixture = (name: string) => readFileSync(join(repo, 'workflows', name), 'utf8')

const available: AvailableCapabilities = {
  workers: new Set(['code-write', 'code.develop', 'research', 'web-search', 'tier.standard']),
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
    resolve(parseWorkflow(yaml), caps, fixture)
  } catch (error) {
    assert.ok(error instanceof WorkflowError, String(error))
    return error.problems
  }
  assert.fail('expected the workflow to be refused')
}

test('both repository Workflow files parse and resolve with the same schema', () => {
  const se = resolve(parseWorkflow(fixture('develop.yaml')), available, fixture)
  const research = resolve(parseWorkflow(fixture('research.yaml')), available)
  assert.deepEqual(se.steps.map((s) => s.id), ['implement', 'satisfied-check', 'checks.checks', 'publish', 'accept'])
  assert.deepEqual(research.steps.map((s) => s.id), ['investigate', 'citations', 'accept'])
  assert.equal(se.workflow.id, 'develop')
  assert.ok(se.workflow.version >= 1)
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
  assert.notEqual(step('idea-a').instructions, step('idea-b').instructions, 'a stance per proposal')
  assert.ok(spec.steps.every((s) => 'capabilities' in s), 'no verify, effect or accept step')
  const noCodex = { ...roles, workers: new Set(['brainstorm.idea-a', 'brainstorm.synthesis']) }
  assert.deepEqual(problems(fixture('brainstorm.yaml'), noCodex), ['step idea-b needs Worker capability brainstorm.idea-b, which no enabled Worker provides'])
})

test('the B3 experiment files resolve: a one-step baseline, and Brainstorm with one shared prompt', () => {
  const roles: AvailableCapabilities = { ...available, workers: new Set(['brainstorm.idea-a', 'brainstorm.idea-b', 'brainstorm.synthesis']) }
  const single = resolve(parseWorkflow(fixture('experiments/brainstorm-single.yaml')), roles)
  assert.deepEqual(single.steps.map((s) => s.id), ['answer'])
  const shared = resolve(parseWorkflow(fixture('experiments/brainstorm-shared.yaml')), roles)
  const stance = resolve(parseWorkflow(fixture('brainstorm.yaml')), roles)
  const strip = (spec: typeof stance) => spec.steps.map((s) => ({ ...s, instructions: undefined }))
  assert.deepEqual(strip(shared), strip(stance), 'only the instructions differ')
  const [a, b] = shared.steps as { instructions?: string }[]
  assert.equal(a!.instructions, b!.instructions)
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
  const found = problems(fixture('develop.yaml'), none)
  assert.deepEqual(found, [
    'step implement needs Worker capability code-write, which no enabled Worker provides',
    'step implement needs Worker capability code.develop, which no enabled Worker provides',
    'step implement needs Worker capability tier.standard, which no enabled Worker provides',
    'step satisfied-check needs verifier code.required-checks, which no enabled verifier provides',
    'step checks.checks needs verifier code.required-checks, which no enabled verifier provides',
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

test('a verify step\'s inputs are checked like a Worker step\'s: the slot must exist and its step be depended on', () => {
  const head = `${base}  - id: a\n    capabilities: [research]\n    outputs: [x]\n  - id: v\n    dependsOn: [a]\n    verify:\n      capability: research.citation-check\n      subject: $steps.a.x\n      criteria: c1\n`
  assert.doesNotThrow(() => resolve(parseWorkflow(`${head}      inputs:\n        report: $steps.a.x\n`), available))
  assert.match(problems(`${head}      inputs:\n        report: $steps.a.nope\n`).join(';'), /input report uses \$steps\.a\.nope: step a has no output nope/)
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

/** Workflow files by name, as the CLI sends the files a Workflow uses. */
const files = (texts: Record<string, string>) => (name: string) => {
  const text = texts[name]
  if (text === undefined) throw new WorkflowError([`uses ${name}: no such file was given`])
  return text
}

const review = `schema: system.workflow/v1
id: review
version: 1
steps:
  - id: write
    capabilities: [research]
    inputs: { task: $work.input }
    outputs: [report]
  - id: check
    dependsOn: [write]
    verify: { capability: research.citation-check, subject: $steps.write.report, criteria: c1 }
`

test('a step that uses another Workflow is expanded in place, with namespaced step IDs, references and dependencies', () => {
  const outer = `${base}  - id: implement
    capabilities: [code-write]
    inputs: { task: $work.input }
    outputs: [change]
  - id: second
    dependsOn: [implement]
    uses: review.yaml
    inputs: { input: $steps.implement.change }
    outputs: { report: $steps.write.report }
  - id: publish
    dependsOn: [second]
    effect: { capability: git.publish, subject: $steps.second.report, requires: [second.check] }
  - id: accept
    dependsOn: [publish]
    accept: { requires: [second.check] }
`
  const spec = resolve(parseWorkflow(outer), available, files({ 'review.yaml': review }))
  assert.deepEqual(spec.steps.map((s) => s.id), ['implement', 'second.write', 'second.check', 'publish', 'accept'])
  assert.deepEqual(spec.steps[1], { id: 'second.write', dependsOn: ['implement'], capabilities: ['research'], inputs: { task: '$steps.implement.change' }, outputs: ['report'] })
  assert.deepEqual(spec.steps[2], { id: 'second.check', dependsOn: ['second.write'], verify: { capability: 'research.citation-check', subject: '$steps.second.write.report', criteria: 'c1' } })
  assert.deepEqual(spec.steps[3], { id: 'publish', dependsOn: ['second.check', 'second.write'], effect: { capability: 'git.publish', subject: '$steps.second.write.report', requires: ['second.check'] } })
  // The same files give the same spec; a Workflow without `uses` resolves as before.
  assert.deepEqual(resolve(parseWorkflow(outer), available, files({ 'review.yaml': review })), spec)
  assert.deepEqual(resolve(parseWorkflow(review), available), resolve(parseWorkflow(review), available, files({})))
})

test('Sub-workflows: recursion, depth 4, a missing file, an accept step inside and a dotted step ID are refused', () => {
  const using = (id: string, name: string) => `schema: system.workflow/v1
id: ${id}
version: 1
steps:
  - id: inner
    uses: ${name}
`
  const refused = (outer: string, texts: Record<string, string>) => {
    try {
      resolve(parseWorkflow(outer), available, files(texts))
    } catch (error) {
      assert.ok(error instanceof WorkflowError, String(error))
      return error.problems.join('; ')
    }
    assert.fail('expected the workflow to be refused')
  }
  assert.match(refused(using('a', 'b.yaml'), { 'b.yaml': using('b', 'a.yaml'), 'a.yaml': using('a', 'b.yaml') }), /recursion: a -> b -> a/)
  assert.match(refused(using('a', 'a.yaml'), { 'a.yaml': using('a', 'a.yaml') }), /recursion: a -> a/)
  // Three levels of uses are allowed; the fourth is refused.
  const chain = { 'l1.yaml': using('l1', 'l2.yaml'), 'l2.yaml': using('l2', 'l3.yaml'), 'l3.yaml': review }
  assert.deepEqual(resolve(parseWorkflow(using('top', 'l1.yaml')), available, files(chain)).steps.map((s) => s.id), ['inner.inner.inner.write', 'inner.inner.inner.check'])
  assert.match(refused(using('top', 'l1.yaml'), { ...chain, 'l3.yaml': using('l3', 'l4.yaml'), 'l4.yaml': review }), /deeper than 3/)
  assert.match(refused(using('top', 'nope.yaml'), {}), /nope\.yaml/)
  assert.match(refused(using('top', 'acc.yaml'), { 'acc.yaml': `${review}  - id: accept\n    dependsOn: [check]\n    accept: { requires: [check] }\n` }), /accept step/)
  assert.match(refused(`${base}  - id: a.b\n    capabilities: [research]\n    outputs: [x]\n`, {}), /a\.b/)
  assert.match(refused(`${base}  - id: s\n    uses: ../escape.yaml\n`, {}), /uses/)
})

test('retry names steps that fail and are tried again: the step itself or later verify steps; max is a small count', () => {
  const w = (retry: string) => `${base}  - id: a
    capabilities: [code-write]
    outputs: [out]
    ${retry}
  - id: v
    dependsOn: [a]
    verify: { capability: code.required-checks, subject: $steps.a.out, criteria: c }
  - id: other
    capabilities: [code-write]
    outputs: [out]
  - id: v2
    dependsOn: [other]
    verify: { capability: code.required-checks, subject: $steps.other.out, criteria: c }
  - id: v3
    dependsOn: [v]
    verify: { capability: code.required-checks, subject: $steps.a.out, criteria: c }
`
  assert.doesNotThrow(() => resolve(parseWorkflow(w('retry: { onFail: [v, a], max: 1 }')), available))
  assert.doesNotThrow(() => resolve(parseWorkflow(w('retry: { onFail: [v3], max: 1 }')), available))
  assert.match(problems(w('retry: { onFail: [nope], max: 1 }')).join(), /step a retry.onFail names nope, which is not a step/)
  assert.match(problems(w('retry: { onFail: [v2], max: 1 }')).join(), /step a retry.onFail names v2, which neither judges nor follows a/)
  assert.match(problems(w('retry: { onFail: [other], max: 1 }')).join(), /step a retry.onFail names other, which neither judges nor follows a/)
  assert.match(problems(w('retry: { onFail: [v], max: 0 }')).join(), /max/)
  assert.match(problems(w('retry: { onFail: [], max: 1 }')).join(), /onFail/)
})

test('retry.rerunUnchanged accepts true and preserves it in the resolved spec', () => {
  const yaml = `${base}  - id: implement
    capabilities: [code-write]
    outputs: [change]
    retry: { onFail: [checks], max: 1, rerunUnchanged: true }
  - id: checks
    dependsOn: [implement]
    verify: { capability: code.required-checks, subject: $steps.implement.change, criteria: c }
`
  assert.doesNotThrow(() => resolve(parseWorkflow(yaml), available))
  const spec = resolve(parseWorkflow(yaml), available)
  const implement = spec.steps[0]!
  assert.deepEqual('retry' in implement && implement.retry, { onFail: ['checks'], max: 1, rerunUnchanged: true })
})

for (const flag of ['false', '1', '"true"']) {
  test(`retry.rerunUnchanged rejects ${flag}`, () => {
    const yaml = `${base}  - id: implement
    capabilities: [code-write]
    outputs: [change]
    retry: { onFail: [checks], max: 1, rerunUnchanged: ${flag} }
  - id: checks
    dependsOn: [implement]
    verify: { capability: code.required-checks, subject: $steps.implement.change, criteria: c }
`
    assert.throws(() => parseWorkflow(yaml), WorkflowError)
  })
}

test('develop.yaml declares the retry on the checks of its Sub-workflow', () => {
  const spec = resolve(parseWorkflow(fixture('develop.yaml')), available, fixture)
  const implement = spec.steps.find((s) => s.id === 'implement')
  assert.deepEqual(implement && 'retry' in implement && implement.retry, { onFail: ['checks.checks', 'publish'], max: 1 })
})

test('every shipped Workflow with a code-write step judged by checks declares the retry on those checks', () => {
  const caps = { ...available, workers: new Set([...available.workers, 'code.tests', 'code.docs', 'tier.economy']) }
  let judged = 0
  for (const file of readdirSync(join(repo, 'workflows')).filter((f) => f.endsWith('.yaml') && fixture(f).includes('uses: code-checks.yaml'))) {
    const steps = resolve(parseWorkflow(fixture(file)), caps, fixture).steps as Record<string, any>[]
    for (const step of steps.filter((s) => s.capabilities?.includes('code-write') && s.outputs?.includes('change'))) {
      const checks = steps.filter((s) => s.id.endsWith('checks.checks') && s.verify?.subject === `$steps.${step.id}.change`).map((s) => s.id)
      if (!checks.length) continue
      judged++
      for (const id of checks) assert.ok(step.retry?.onFail.includes(id), `${file}: ${step.id} must retry on ${id}`)
    }
  }
  assert.ok(judged >= 2, String(judged))
})

test('retry.onFail may name an effect step that follows the Worker', () => {
  const yaml = publishing('      capability: git.publish\n      subject: $steps.implement.change\n      requires: [checks]')
    .replace('outputs: [change]', 'outputs: [change]\n    retry: { onFail: [publish], max: 1 }')
  assert.doesNotThrow(() => resolve(parseWorkflow(yaml), available))
})

test('retry.onFail refuses an effect that does not follow the Worker', () => {
  const yaml = publishing('      capability: git.publish\n      subject: $steps.implement.change\n      requires: [checks]') + `  - id: unrelated
    capabilities: [code-write]
    outputs: [change]
    retry: { onFail: [publish], max: 1 }
`
  assert.match(problems(yaml).join(), /step unrelated retry.onFail names publish, which neither judges nor follows unrelated/)
  assert.match(problems(yaml.replace('onFail: [publish]', 'onFail: [ghost]')).join(), /retry.onFail names ghost, which is not a step/)
})

for (const file of ['develop.yaml', 'hygiene.yaml']) {
  test(`${file} declares publish in implement retry.onFail and validates`, () => {
    const caps = { ...available, workers: new Set([...available.workers, 'code.tests', 'code.docs', 'tier.economy']) }
    const spec = resolve(parseWorkflow(fixture(file)), caps, fixture)
    const implement = spec.steps.find((s) => s.id === 'implement')
    assert.ok(implement && 'retry' in implement && implement.retry?.onFail.includes('publish'))
  })
}


test('prefer rejects an invalid capability string', () => {
  const yaml = `${base}  - id: a
    capabilities: [research]
    prefer: Bad_role!
    outputs: [x]
`
  assert.throws(() => parseWorkflow(yaml), WorkflowError)
})

test('an unknown prefer capability is optional at resolution and carried into the pinned spec', () => {
  const yaml = `${base}  - id: a
    capabilities: [research]
    prefer: research.web
    outputs: [x]
`
  assert.equal(available.workers.has('research.web'), false)
  let spec: ReturnType<typeof resolve> | undefined
  assert.doesNotThrow(() => { spec = resolve(parseWorkflow(yaml), available) })
  assert.equal(Reflect.get(spec!.steps[0]!, 'prefer'), 'research.web')
})

const OPTIONAL = `${base}  - id: implement
    capabilities: [code-write]
    outputs: [change]
    optionalOutputs: [satisfied]
  - id: only
    dependsOn: [implement]
    when: $steps.implement.satisfied
    verify: { capability: code.required-checks, subject: $work.input, criteria: repo-checks-v1, inputs: { tests: $steps.implement.satisfied } }
`

test('an optional output is read only by a step that runs only when it exists; `when` and `unless` name one', () => {
  assert.deepEqual(resolve(parseWorkflow(OPTIONAL), available).steps.map((s) => s.id), ['implement', 'only'])
  assert.deepEqual(problems(OPTIONAL.replace('    when: $steps.implement.satisfied\n', '')), ['step only input tests uses $steps.implement.satisfied: an optional output is read only by a step with `when` naming it'])
  assert.deepEqual(problems(OPTIONAL.replace('when: $steps.implement.satisfied', 'when: $steps.implement.change')), ['step only when $steps.implement.change: step implement has no optional output change', 'step only input tests uses $steps.implement.satisfied: an optional output is read only by a step with `when` naming it'])
  assert.deepEqual(problems(OPTIONAL.replace('    when: $steps.implement.satisfied\n', '    when: $steps.implement.satisfied\n    unless: $steps.implement.satisfied\n')), ['step only has both when and unless'])
  assert.deepEqual(problems(OPTIONAL.replace('    dependsOn: [implement]\n', '')), ['step only when $steps.implement.satisfied, but does not depend on implement', 'step only input tests uses $steps.implement.satisfied, but does not depend on implement'])
  assert.ok(problems(OPTIONAL.replace('optionalOutputs: [satisfied]', 'optionalOutputs: [change]')).includes('step implement names an output twice'))
})

test('a using step\'s `when` or `unless` applies to every step of its Sub-workflow; develop.yaml names satisfied once', () => {
  const spec = resolve(parseWorkflow(fixture('develop.yaml')), available, fixture)
  const by = (id: string) => spec.steps.find((s) => s.id === id) as { when?: string; unless?: string }
  assert.deepEqual(['satisfied-check', 'checks.checks', 'publish', 'accept'].map((id) => [by(id).when, by(id).unless]), [
    ['$steps.implement.satisfied', undefined], [undefined, '$steps.implement.satisfied'], [undefined, '$steps.implement.satisfied'], [undefined, '$steps.implement.satisfied'],
  ])
  const implement = spec.steps.find((s) => s.id === 'implement') as { outputs: string[]; optionalOutputs?: string[] }
  assert.deepEqual([implement.outputs, implement.optionalOutputs], [['change'], ['satisfied']])
})
