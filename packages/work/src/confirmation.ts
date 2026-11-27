/**
 * `confirmation@1` (Item ms-2): the operator confirmed a stored Artifact (a dataset, a set of labels), recorded beside it
 * because an Artifact is immutable and any kind can be confirmed; `work report` counts each as an operator act.
 */
import { contentIdSchema, type Artifacts, type Envelope } from '@system/artifacts'
import { z } from 'zod'
import { WorkError } from './errors.ts'
import { storedOf } from './stored.ts'

export const CONFIRMATION_KIND = { kind: 'confirmation', schemaVersion: 1 } as const
export const confirmationSchema = z.object({
  /** The Artifact the operator confirmed. */
  subject: contentIdSchema,
  by: z.literal('operator'),
  /** When it was confirmed (ISO date or timestamp). */
  date: z.string().min(10).max(40),
  note: z.string().min(1).max(8 * 1024),
}).strict()
type Confirmation = z.infer<typeof confirmationSchema>
export interface ConfirmationInput { subject: string; note: string; date?: string }

/** Store a `confirmation@1`; the subject must be a stored Artifact. */
export async function addConfirmation(artifacts: Artifacts, input: ConfirmationInput, producer: { type: 'operator'; ref: string }, now: () => string = () => new Date().toISOString()): Promise<Envelope> {
  const content = confirmationSchema.parse({ subject: input.subject, by: 'operator', date: input.date ?? now(), note: input.note })
  if (artifacts.get(content.subject).state !== 'stored') throw new WorkError(`${content.subject} is not a stored Artifact`)
  return artifacts.put({ ...CONFIRMATION_KIND, content, classification: 'local-private', producer })
}

export function storedConfirmations(artifacts: Artifacts): Confirmation[] {
  return storedOf<Confirmation>(artifacts, CONFIRMATION_KIND.kind).map((s) => s.content)
}
