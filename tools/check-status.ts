/**
 * The `statusmd` check (Item cm-4): fails on any problem in STATUS.md (a bad line, a duplicate ID, an unknown ID after
 * `after:`, a cycle), so a broken STATUS.md cannot merge. Usage: node tools/check-status.ts [path]
 */
import { readFileSync } from 'node:fs'
import { parseStatus } from '../packages/work/src/status-parse.ts'

const path = process.argv[2] ?? 'STATUS.md'
try {
  const { items } = parseStatus(readFileSync(path, 'utf8'), { strict: true })
  console.log(`${path}: ${items.length} Items, no problems`)
} catch (error) {
  console.error(`${path}: ${(error as Error).message}`)
  process.exit(1)
}
