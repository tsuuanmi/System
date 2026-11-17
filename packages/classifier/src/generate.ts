/** Write `schemas/` from the zod schemas and the shipped questions: `node packages/classifier/src/generate.ts`. */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadQuestions } from './question.ts'
import { generatedSchemas } from './schema.ts'

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, '..', 'schemas')
rmSync(target, { recursive: true, force: true })
for (const [file, schema] of Object.entries(generatedSchemas(loadQuestions(join(here, '..', '..', '..', 'classifiers'))))) {
  mkdirSync(dirname(join(target, file)), { recursive: true })
  writeFileSync(join(target, file), `${JSON.stringify(schema, null, 2)}\n`)
}
