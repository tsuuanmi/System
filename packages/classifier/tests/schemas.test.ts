import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { memoryArtifacts } from '../../../test-support/memory.ts'
import { answerSchema, createClassifier, generatedSchemas, loadQuestions, parseQuestion, questionSchema } from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')
const require_ = createRequire(import.meta.url)
const Ajv = require_('ajv').default as new (options: object) => { compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown } }
const ajv = new Ajv({ strict: false, allErrors: true })

const onDisk = (name: string): unknown => JSON.parse(readFileSync(join(here, '..', 'schemas', name), 'utf8'))

test('the JSON Schema files are exactly what the zod schemas generate (one source of truth)', () => {
  const generated = generatedSchemas(loadQuestions(join(root, 'classifiers')))
  assert.deepEqual(Object.keys(generated).sort(), readdirSync(join(here, '..', 'schemas'), { recursive: true }).map(String).filter((f) => f.endsWith('.json')).sort(), 'no file of schemas/ is hand-kept or missing')
  for (const [name, schema] of Object.entries(generated)) assert.deepEqual(onDisk(name), schema, `${name} drifted: run node packages/classifier/src/generate.ts`)
})

test('the shipped question files validate against question.schema.json and the zod schema', () => {
  const validate = ajv.compile(onDisk('question.schema.json') as object)
  const files = readdirSync(join(root, 'classifiers')).filter((f) => f.endsWith('.yaml'))
  assert.ok(files.includes('failure-cause.yaml'))
  for (const file of files) {
    const text = readFileSync(join(root, 'classifiers', file), 'utf8')
    const { hash, ...parsed } = parseQuestion(text)
    assert.match(hash, /^sha256:[0-9a-f]{64}$/)
    assert.ok(validate(JSON.parse(JSON.stringify(parsed))), `${file}: ${JSON.stringify(validate.errors)}`)
    assert.ok(parsed.labels.some((l) => l.label === 'unknown'), `${file} has unknown`)
  }
  const failure = loadQuestions(join(root, 'classifiers')).find((q) => q.name === 'failure-cause')!
  assert.deepEqual(failure.labels.map((l) => l.label), ['quota', 'restart', 'conflict', 'load', 'slow-host', 'attach', 'flaky', 'process', 'change', 'unknown'])
  assert.equal(failure.version, 2)
  assert.equal(failure.samples, 3)
})

test('a question without unknown, with a duplicate label or an example off its labels is refused', () => {
  const base = { name: 'q', version: 1, instructions: 'i', samples: 3 }
  const label = (l: string) => ({ label: l, description: 'd' })
  assert.equal(questionSchema.safeParse({ ...base, labels: [label('a'), label('b')] }).success, false)
  assert.equal(questionSchema.safeParse({ ...base, labels: [label('a'), label('a'), label('unknown')] }).success, false)
  assert.equal(questionSchema.safeParse({ ...base, labels: [label('a'), label('unknown')], examples: [{ input: 'x', label: 'zzz' }] }).success, false)
  assert.equal(questionSchema.safeParse({ ...base, labels: [label('a'), label('unknown')] }).success, true)
})

test('the answer schema has the question\'s labels as the enum of `label`', () => {
  const question = loadQuestions(join(root, 'classifiers')).find((q) => q.name === 'failure-cause')!
  const validate = ajv.compile(onDisk('answers/failure-cause.answer.schema.json') as object)
  assert.ok(validate({ label: 'quota' }))
  assert.ok(validate({ label: 'slow-host', reason: 'timed out' }))
  assert.equal(validate({ label: 'banana' }), false)
  assert.equal(validate({}), false)
  assert.equal(answerSchema(question).safeParse({ label: 'banana' }).success, false)
})

test('a recorded Classification and the fixtures validate against classification.schema.json; a broken one does not', async () => {
  const validate = ajv.compile(onDisk('classification.schema.json') as object)
  const question = parseQuestion(readFileSync(join(root, 'classifiers', 'failure-cause.yaml'), 'utf8'))
  const { artifacts } = memoryArtifacts()
  const classifier = createClassifier({ artifacts, index: { get: () => undefined, put: async () => {} }, ask: async () => ({ ok: true, text: '{"label":"quota"}', ref: 'codex/e', runtime: 'codex', runtimeVersion: 'v' }), questions: [question] })
  const got = await classifier.classify('failure-cause', 'You hit your limit', { exclude: [] })
  const content = (artifacts.get(got!.classification) as any).envelope.content
  assert.ok(validate(content), JSON.stringify(validate.errors))
  assert.equal(validate({ ...content, confidence: 2 }), false)
  assert.equal(validate({ ...content, label: undefined }), false)
  assert.equal(validate({ ...content, input: 'not a hash' }), false)
})
