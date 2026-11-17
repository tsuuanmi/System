/** Question files: `classifiers/<name>.yaml`, read and hashed by their bytes. */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { questionSchema, type Question } from './schema.ts'

/** The hash of a text as an Artifact-style content ID. */
export const hashText = (text: string | Uint8Array): string => `sha256:${createHash('sha256').update(text).digest('hex')}`

/** A question and the hash of the file it was read from. */
export interface LoadedQuestion extends Question {
  hash: string
}

/** A question from its YAML text, with the hash of that text; throws with what is wrong. */
export function parseQuestion(text: string | Uint8Array): LoadedQuestion {
  const parsed = questionSchema.safeParse(parse(Buffer.from(text).toString('utf8'), { logLevel: 'error' }))
  if (!parsed.success) throw new Error(`invalid question: ${parsed.error.message}`)
  return { ...parsed.data, hash: hashText(text) }
}

/** Every `*.yaml` of `directory`, sorted by file name. A file that is not a question is an error naming it. */
export function loadQuestions(directory: string): LoadedQuestion[] {
  return readdirSync(directory).filter((f) => f.endsWith('.yaml')).sort().map((file) => {
    const bytes = readFileSync(join(directory, file))
    try {
      return parseQuestion(bytes)
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`)
    }
  })
}
