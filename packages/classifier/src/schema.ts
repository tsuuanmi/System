/**
 * The Classifier's contracts, as zod: the question file, the model's answer and `classification@1`. The JSON Schema files in
 * `schemas/` are generated from these (`generatedSchemas`, `node packages/classifier/src/generate.ts`), never kept by hand;
 * a test fails when they drift.
 */
import { contentIdSchema } from '@system/artifacts'
import { z } from 'zod'

const name = z.string().regex(/^[a-z][a-z0-9-]*$/)

/** A label in a question file: a lowercase word that may carry hyphens. */
const label = z.string().regex(/^[a-z][a-z0-9-]*$/)

export const UNKNOWN = 'unknown'

/** `classifiers/<name>.yaml`: a versioned, closed question. Its labels always include `unknown`. */
export const questionSchema = z.object({
  name,
  version: z.number().int().positive(),
  instructions: z.string().min(1),
  labels: z.array(z.object({ label, description: z.string().min(1) }).strict()).min(2),
  examples: z.array(z.object({ input: z.string().min(1), label }).strict()).optional(),
  /** How many times the Account is asked; the votes decide. */
  samples: z.number().int().min(1).max(9),
}).strict().superRefine((q, ctx) => {
  const labels = q.labels.map((l) => l.label)
  if (new Set(labels).size !== labels.length) ctx.addIssue({ code: 'custom', message: 'labels are not unique' })
  if (!labels.includes(UNKNOWN)) ctx.addIssue({ code: 'custom', message: `labels must include ${UNKNOWN}` })
  for (const e of q.examples ?? []) if (!labels.includes(e.label)) ctx.addIssue({ code: 'custom', message: `example label ${e.label} is not one of the labels` })
})
export type Question = z.infer<typeof questionSchema>

/** What the model answers: `label` is one of the question's labels (the enum), `reason` is free text, never read. */
export function answerSchema(question: Pick<Question, 'labels'>) {
  const [first, ...rest] = question.labels.map((l) => l.label)
  return z.object({ label: z.enum([first!, ...rest]), reason: z.string().optional() }).strict()
}

const hash = contentIdSchema

/** `classification@1`: one recorded answer. */
export const CLASSIFICATION_KIND = { kind: 'classification', schemaVersion: 1 } as const
export const classificationSchema = z.object({
  question: z.object({ name, version: z.number().int().positive(), hash }).strict(),
  /** The hash of the input text the question was asked about. */
  input: hash,
  /** One entry per sample: the label the model answered (absent when it answered none of the shape) and who answered. */
  samples: z.array(z.object({ answer: z.string().optional(), ref: z.string().min(1), runtime: z.string().min(1), model: z.string().min(1).optional(), runtimeVersion: z.string() }).strict()).min(1),
  /** The share of the votes of each label; an off-enum or missing answer is a vote for `unknown`. */
  distribution: z.record(z.string(), z.number().min(0).max(1)),
  /** The winner's share of the votes. */
  confidence: z.number().min(0).max(1),
  label: z.string().min(1),
  /** Whether the samples did not all give the same answer. */
  disagreement: z.boolean(),
}).strict()
export type Classification = z.infer<typeof classificationSchema>

/** The JSON Schema files, by path under `schemas/`: one for the question, one for the Classification, one answer schema per question. */
export function generatedSchemas(questions: readonly Question[]): Record<string, object> {
  const json = (schema: z.ZodType): object => z.toJSONSchema(schema, { target: 'draft-7', io: 'input', unrepresentable: 'any' })
  return {
    'question.schema.json': json(questionSchema),
    'classification.schema.json': json(classificationSchema),
    ...Object.fromEntries(questions.map((q) => [`answers/${q.name}.answer.schema.json`, json(answerSchema(q))])),
  }
}
