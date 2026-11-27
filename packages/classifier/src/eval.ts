/**
 * The Classifier's gate (cls-2): the rules, the Classifier and the hybrid measured on a labelled set of failures.
 * `evaluate` is pure but for the `Ask` it is given (a fake in tests, a real Runtime in the operator's one run);
 * `gate` reads a report and answers pass or fail. No control path reads either: a Classification stays report-only.
 */
import type { Ask } from '@system/agents'
import type { Artifacts } from '@system/artifacts'
import { defaultChange, laterPasses, summarize, type WorkRecord } from '@system/work'
import { createClassifier } from './classifier.ts'
import { failureEvidence } from './evidence.ts'
import type { LoadedQuestion } from './question.ts'
import { classificationSchema } from './schema.ts'

/** The labelled set Artifact's content (`failure-cause labelled set`). */
export interface LabelledSet {
  items: { work: string; kind: string; event: string; reason: string; label: string; evidence?: string }[]
}

/** Classes a failure is Outside of the change; a `change` placed in one of them is an error the gate never allows. */
const OUTSIDE_LABELS: ReadonlySet<string> = new Set(['quota', 'restart', 'conflict', 'load', 'slow-host', 'attach', 'flaky', 'process'])

interface Metrics {
  total: number
  correct: number
  accuracy: number
  /** Wilson 95% interval of `accuracy`. */
  interval: [number, number]
  /** Items whose answer was `unknown`, over `total`. */
  unknownRate: number
  /** `confusion[gold][answered]` counts. */
  confusion: Record<string, Record<string, number>>
  /** Items of gold `change` answered with an Outside class. */
  changeToOutside: number
}

export interface EvalReport {
  question: { name: string; version: number; hash: string }
  /** The labelled set's Artifact. */
  set: string
  items: number
  rules: Metrics
  classifier: Metrics
  /** The rules' class, except: `unknown` takes the Classifier's answer, and a default `change` (no positive evidence) takes it when every sample agreed. */
  hybrid: Metrics
  /** Items whose rules class was a default `change` and so was put to the Classifier (cls-6). */
  asked: number
  /** Items the Classifier could not answer (every turn failed); counted as `unknown`. */
  unanswered: number
  disagreement: { items: number; samples: { work: string; event: string; gold: string; answers: string[] }[] }
}

/** Wilson score interval of `k` of `n` at 95%. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1]
  const p = k / n
  const denominator = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)]
}

function metrics(pairs: { gold: string; answer: string }[]): Metrics {
  const confusion: Metrics['confusion'] = {}
  let correct = 0
  let unknown = 0
  let changeToOutside = 0
  for (const { gold, answer } of pairs) {
    const row = (confusion[gold] ??= {})
    row[answer] = (row[answer] ?? 0) + 1
    if (gold === answer) correct += 1
    if (answer === 'unknown') unknown += 1
    if (gold === 'change' && OUTSIDE_LABELS.has(answer)) changeToOutside += 1
  }
  const total = pairs.length
  return { total, correct, accuracy: total ? correct / total : 0, interval: wilson(correct, total), unknownRate: total ? unknown / total : 0, confusion, changeToOutside }
}

interface EvalOptions {
  set: LabelledSet
  /** The set's Artifact ID. */
  artifact: string
  /** The Work records the items are read from, by Work ID. */
  records: Record<string, WorkRecord>
  /** Change Artifact ID to its git tree (the Host reads it from the `git-tree@1` Artifact): the same tree under another ID is the same change (cls-5). */
  trees?: Record<string, string>
  question: LoadedQuestion
  ask: Ask
  /** Where the Classifier records its answers: throwaway in tests, the Host's store otherwise. */
  artifacts: Artifacts
  /** Called after each item, for progress. */
  progress?: (done: number, total: number) => void
}

/** Run the rules, the Classifier and the hybrid over every item. Never throws on a Classifier that cannot answer. */
export async function evaluate({ set, artifact, records, trees, question, ask, artifacts, progress }: EvalOptions): Promise<EvalReport> {
  const index = new Map<string, { artifact: string }>()
  const classifier = createClassifier({ artifacts, questions: [question], ask, index: { get: (k) => index.get(k), put: async (k, v) => { index.set(k, v) } } })
  const later = laterPasses(Object.values(records), trees ? (c) => trees[c] ?? c : undefined)
  const rulesPairs: { gold: string; answer: string }[] = []
  const classifierPairs: typeof rulesPairs = []
  const hybridPairs: typeof rulesPairs = []
  const disagreement: EvalReport['disagreement'] = { items: 0, samples: [] }
  let unanswered = 0
  let asked = 0
  for (const [n, item] of set.items.entries()) {
    const record = records[item.work]
    if (!record) throw new Error(`no record of ${item.work}`)
    const failure = summarize(record, undefined, later).failures.find((f) => f.event === item.event)
    if (!failure) throw new Error(`${item.work} has no failure at ${item.event}`)
    const rules = failure.outside ?? (failure.unknown ? 'unknown' : 'change')
    const got = await classifier.classify(question.name, failureEvidence(failure, record, later), { exclude: [] })
    if (!got) unanswered += 1
    const answered = got?.label ?? 'unknown'
    rulesPairs.push({ gold: item.label, answer: rules })
    classifierPairs.push({ gold: item.label, answer: answered })
    // cls-6: `unknown` goes to the Classifier; a default `change` goes to it too but keeps `change` unless every sample agreed.
    const isDefault = defaultChange(failure)
    if (isDefault) asked += 1
    const unanimous = got !== undefined && got.confidence === 1 && got.label !== 'unknown'
    hybridPairs.push({ gold: item.label, answer: rules === 'unknown' ? answered : isDefault && unanimous ? answered : rules })
    if (got) {
      const stored = artifacts.get(got.classification)
      const content = stored.state === 'stored' ? classificationSchema.safeParse(stored.envelope.content) : undefined
      if (content?.success && content.data.disagreement) {
        disagreement.items += 1
        if (disagreement.samples.length < 5) disagreement.samples.push({ work: item.work, event: item.event, gold: item.label, answers: content.data.samples.map((s) => s.answer ?? '') })
      }
    }
    progress?.(n + 1, set.items.length)
  }
  return {
    question: { name: question.name, version: question.version, hash: question.hash },
    set: artifact, items: set.items.length,
    rules: metrics(rulesPairs), classifier: metrics(classifierPairs), hybrid: metrics(hybridPairs),
    asked, unanswered, disagreement,
  }
}

/** The gate: no control use of a Classification until the hybrid is at least as accurate as the rules and never turns a failure of the change into an Outside failure. */
export function gate(report: Pick<EvalReport, 'rules' | 'hybrid'>): { pass: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (report.hybrid.accuracy < report.rules.accuracy) reasons.push(`the hybrid is less accurate than the rules (${report.hybrid.correct}/${report.hybrid.total} against ${report.rules.correct}/${report.rules.total})`)
  if (report.hybrid.changeToOutside > 0) reasons.push(`${report.hybrid.changeToOutside} change→Outside error(s): a failure of the change classed as an Outside failure`)
  return { pass: reasons.length === 0, reasons }
}

/** A human-readable summary of a report: the three accuracies with intervals, the `unknown` rate, the gate. */
export function formatReport(report: EvalReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  const line = (name: string, m: Metrics) => `${name.padEnd(11)} ${m.correct}/${m.total} = ${pct(m.accuracy)} (95% ${pct(m.interval[0])}–${pct(m.interval[1])}), unknown ${pct(m.unknownRate)}, change→Outside ${m.changeToOutside}`
  const verdict = gate(report)
  return [
    `failure-cause v${report.question.version} on ${report.items} items of ${report.set}`,
    line('rules', report.rules), line('classifier', report.classifier), line('hybrid', report.hybrid),
    `classifier unanswered ${report.unanswered}; asked in place of a default change ${report.asked}; samples disagreed on ${report.disagreement.items}`,
    `gate: ${verdict.pass ? 'pass' : `fail: ${verdict.reasons.join('; ')}`}`,
  ].join('\n')
}
