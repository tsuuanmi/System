/**
 * The Classifier core (cls-1): asks one closed question about a text `samples` times through an `Ask` (an economy-tier
 * Account of an existing Runtime), votes, and records the answer once as a `classification@1` Artifact. A reader gets a
 * recorded answer and never calls the model. It never throws: a Classifier that cannot answer records nothing.
 */
import type { Ask } from '@system/agents'
import type { Artifacts } from '@system/artifacts'
import { defaultChange, summarize, type ClassifiedFailure, type ClassifiedLookup, type Failure, type WorkRecord } from '@system/work'
import { failureEvidence } from './evidence.ts'
import { hashText, type LoadedQuestion } from './question.ts'
import { CLASSIFICATION_KIND, classificationSchema, type Classification } from './schema.ts'
import { vote } from './vote.ts'

/** Where a recorded answer is found: `<question>@<version>:<input hash>` to the Classification Artifact. */
export interface ClassificationIndex {
  get(key: string): { artifact: string } | undefined
  put(key: string, value: { artifact: string }): Promise<void>
}

export interface ClassifierOptions {
  artifacts: Artifacts
  index: ClassificationIndex
  ask: Ask
  questions: readonly LoadedQuestion[]
}

/** The text version 1 Classifications were made from: the failure's kind and recorded reason. Kept to read them. */
export const failureText = (failure: Pick<Failure, 'kind' | 'reason'>): string => `${failure.kind}: ${failure.reason}`

/** The prompt of one sample: the question, its labels, its examples and the text, asking for a JSON object only. */
export function promptFor(question: LoadedQuestion, text: string): string {
  return [
    question.instructions.trim(),
    '',
    'Labels:',
    ...question.labels.map((l) => `- ${l.label}: ${l.description}`),
    ...(question.examples?.length ? ['', 'Examples:', ...question.examples.flatMap((e) => [`Input: ${e.input}`, `Answer: ${JSON.stringify({ label: e.label })}`])] : []),
    '',
    'Input:',
    '<<<',
    text,
    '>>>',
    '',
    `Reply with only a JSON object {"label": "<one of: ${question.labels.map((l) => l.label).join(', ')}>"}, and no other text.`,
  ].join('\n')
}

/** The label a reply gives: the `label` of the JSON object in it (a fenced block is fine); undefined when it has none. It may be off the enum. */
export function answerOf(text: string): string | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return undefined
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    const label = parsed && typeof parsed === 'object' ? (parsed as { label?: unknown }).label : undefined
    return typeof label === 'string' ? label : undefined
  } catch {
    return undefined
  }
}

export function createClassifier({ artifacts, index, ask, questions }: ClassifierOptions) {
  artifacts.registerKind({ ...CLASSIFICATION_KIND, content: classificationSchema })
  const byName = new Map(questions.map((q) => [q.name, q]))
  const pending = new Map<string, Promise<ClassifiedFailure | undefined>>()
  const keyOf = (question: LoadedQuestion, text: string) => `${question.name}@${question.version}:${hashText(text)}`

  function recorded(key: string): ClassifiedFailure | undefined {
    const found = index.get(key)
    if (!found) return undefined
    const read = artifacts.get(found.artifact)
    if (read.state !== 'stored') return undefined
    const content = classificationSchema.safeParse(read.envelope.content)
    return content.success ? { label: content.data.label, confidence: content.data.confidence, classification: found.artifact } : undefined
  }

  async function sample(question: LoadedQuestion, text: string, exclude: string[]): Promise<ClassifiedFailure | undefined> {
    const samples: Classification['samples'] = []
    for (let n = 0; n < question.samples; n += 1) {
      const got = await ask(promptFor(question, text), { exclude })
      // A turn that failed is no vote: nothing is recorded, so a later report asks again.
      if (!got.ok) return undefined
      samples.push({ ...(answerOf(got.text) === undefined ? {} : { answer: answerOf(got.text)! }), ref: got.ref, runtime: got.runtime, ...(got.model ? { model: got.model } : {}), runtimeVersion: got.runtimeVersion })
    }
    const voted = vote(samples.map((s) => s.answer), question.labels.map((l) => l.label))
    const content: Classification = { question: { name: question.name, version: question.version, hash: question.hash }, input: hashText(text), samples, ...voted }
    const stored = await artifacts.put({ ...CLASSIFICATION_KIND, content, classification: 'local-private', producer: { type: 'system', ref: 'classifier' } })
    await index.put(keyOf(question, text), { artifact: stored.id })
    return { label: voted.label, confidence: voted.confidence, classification: stored.id }
  }

  const classifier = {
    /** The recorded answer of `question` about `text`, if any. Never asks. */
    lookup(question: string, text: string, legacyText?: string): ClassifiedFailure | undefined {
      const q = byName.get(question)
      try {
        // A version 1 answer stays as recorded: it was made from the reason text alone, under the version-1 key.
        return q && (recorded(keyOf(q, text)) ?? (legacyText === undefined ? undefined : recorded(`${q.name}@1:${hashText(legacyText)}`)))
      } catch {
        return undefined
      }
    },
    /** The recorded answer, else ask now (off the Accounts in `exclude`) and record it; undefined when it cannot answer. Never throws. */
    async classify(question: string, text: string, { exclude }: { exclude: string[] }): Promise<ClassifiedFailure | undefined> {
      const q = byName.get(question)
      if (!q) return undefined
      const key = keyOf(q, text)
      try {
        const known = recorded(key)
        if (known) return known
        let running = pending.get(key)
        if (!running) {
          running = sample(q, text, exclude).catch(() => undefined).finally(() => { pending.delete(key) })
          pending.set(key, running)
        }
        return await running
      } catch {
        return undefined
      }
    },
    /** For `summarize` and `rangeReport`: the recorded answer of `question` about a failure. */
    failureLookup(question: string): ClassifiedLookup {
      return (failure, record) => classifier.lookup(question, failureEvidence(failure, record), failureText(failure))
    },
    /** Classify the failures of `record` whose rules answer `unknown` or only the default `change` (cls-6) and that have no answer yet, off the Account that failed. */
    async classifyFailures(question: string, record: WorkRecord): Promise<void> {
      for (const failure of summarize(record).failures) {
        if (!(failure.unknown || defaultChange(failure)) || failure.kind === 'touch') continue
        const text = failureEvidence(failure, record)
        if (classifier.lookup(question, text, failureText(failure))) continue
        const account = failedAccount(record, Number(failure.event.split('#')[1]))
        await classifier.classify(question, text, { exclude: account ? [account] : [] })
      }
    },
  }
  return classifier
}

export type Classifier = ReturnType<typeof createClassifier>

/** The Account of the last attempt reported at or before event `index`: the one whose failure is classified. */
function failedAccount(record: WorkRecord, index: number): string | undefined {
  for (let i = Math.min(index, record.events.length - 1); i >= 0; i -= 1) {
    const event = record.events[i]!
    if (event.type !== 'observed') continue
    if (event.worker?.ref) return event.worker.ref
    const dispatched = record.events.find((e) => e.type === 'dispatched' && e.attemptId === event.attemptId && e.executor === 'worker')
    return dispatched?.type === 'dispatched' ? dispatched.selected : undefined
  }
  return undefined
}
