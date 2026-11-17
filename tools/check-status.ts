/**
 * The `statusmd` check (Item cm-4): fails on any problem in STATUS.md (a bad line, a duplicate ID, an unknown ID after
 * `after:`, a cycle), so a broken STATUS.md cannot merge. Usage: node tools/check-status.ts [path] [--intents <file>]
 *
 * Item in-2: an `(intent: <12 hex>)` must be the prefix of exactly one stored `intent@1` Artifact. The check runs without a
 * Host and without an install, and the Artifact store is a DSH storage domain that only a running DSH opens, so it does not
 * open the store. `--intents <file>` names the stored `intent@1` IDs (one `sha256:<hex>` per line) to check against; without
 * it the existence check is skipped and the result says so in a `note:` line (never a silent pass).
 */
import { readFileSync } from 'node:fs'
import { parseStatus } from '../packages/work/src/status-parse.ts'

const args = process.argv.slice(2)
const flag = args.indexOf('--intents')
const intentsFile = flag >= 0 ? args.splice(flag, 2)[1] : undefined
const path = args[0] ?? 'STATUS.md'
try {
  const text = readFileSync(path, 'utf8')
  const { items } = parseStatus(text, { strict: true })
  const withIntent = items.filter((item) => item.intent)
  const problems: string[] = []
  let note = ''
  if (intentsFile) {
    const stored = readFileSync(intentsFile, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)
    const lines = text.split('\n')
    for (const item of withIntent) {
      const found = new Set(stored.filter((id) => id.startsWith(`sha256:${item.intent}`)))
      const at = lines.findIndex((line) => new RegExp(`^[-*] \\[[ xX]\\] ${item.id}(\\s|$)`).test(line)) + 1
      if (found.size !== 1) problems.push(`line ${at}: Item ${item.id} names intent ${item.intent}, ${found.size ? `which matches ${found.size} stored Artifacts` : 'which is not a stored intent@1 Artifact'}`)
    }
  } else if (withIntent.length) {
    note = `\nnote: ${withIntent.length} intent prefix${withIntent.length === 1 ? '' : 'es'} not checked: no Artifact store is reachable from this check (pass --intents <file> of stored intent@1 IDs)`
  }
  if (problems.length) throw new Error(`STATUS.md has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map((p) => `  ${p}`).join('\n')}`)
  console.log(`${path}: ${items.length} Items, no problems${note}`)
} catch (error) {
  console.error(`${path}: ${(error as Error).message}`)
  process.exit(1)
}
