/**
 * The real Classifier evaluation (cls-2), run once by the operator or a session; never by a required check.
 *   node tools/classifier-eval.ts --ask-command '<command>' [--set <json>] [--records <json>] [--questions <dir>]
 * `--ask-command` is a shell command that reads one prompt on stdin and writes the model's reply on stdout, e.g.
 * `claude -p --model haiku --tools ''`; it is run once per sample. The report JSON goes to stdout, a summary to stderr.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { memoryArtifacts } from '../test-support/memory.ts'
import type { Ask } from '@system/agents/contract'
import { DEFAULT_DIRECTORY, loadQuestions } from '../packages/classifier/src/index.ts'
import { evaluate, formatReport, type LabelledSet } from '../packages/classifier/src/eval.ts'

const fixtures = new URL('../packages/classifier/tests/fixtures/', import.meta.url)
const { values } = parseArgs({ options: {
  'ask-command': { type: 'string' },
  set: { type: 'string', default: new URL('failure-cause-labelled.json', fixtures).pathname },
  records: { type: 'string', default: new URL('failure-cause-records.json', fixtures).pathname },
  questions: { type: 'string', default: DEFAULT_DIRECTORY },
} })
if (!values['ask-command']) throw new Error('--ask-command is required')

const ask: Ask = (prompt) => new Promise((resolve) => {
  const child = spawn('sh', ['-c', values['ask-command']!], { stdio: ['pipe', 'pipe', 'inherit'], timeout: 120_000 })
  let out = ''
  child.stdout.on('data', (d: Buffer) => { out += d.toString() })
  child.on('error', (e) => resolve({ ok: false, reason: e.message }))
  child.on('close', (code) => resolve(code === 0 && out.trim() ? { ok: true, text: out, ref: 'ask-command', runtime: 'ask-command', runtimeVersion: '1' } : { ok: false, reason: `exit ${code}` }))
  child.stdin.end(prompt)
})

const labelled = JSON.parse(readFileSync(values.set!, 'utf8')) as { artifact: string; set: LabelledSet }
const records = (JSON.parse(readFileSync(values.records!, 'utf8')) as { records: Parameters<typeof evaluate>[0]['records'] }).records
const question = loadQuestions(values.questions!).find((q) => q.name === 'failure-cause')!
const report = await evaluate({ set: labelled.set, artifact: labelled.artifact, records, question, ask, artifacts: memoryArtifacts().artifacts, progress: (n, t) => process.stderr.write(`\r${n}/${t}`) })
process.stderr.write(`\n${formatReport(report)}\n`)
process.stdout.write(`${JSON.stringify(report, null, 1)}\n`)
