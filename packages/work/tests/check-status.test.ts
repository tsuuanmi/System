/** in-2: the `statusmd` check and the Item's `(intent: ...)` marker. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const tool = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tools', 'check-status.ts')
const dir = mkdtempSync(join(tmpdir(), 'check-status-'))
const sha = (hex: string) => `sha256:${hex.padEnd(64, '0')}`
const file = (name: string, text: string) => { const p = join(dir, name); writeFileSync(p, text); return p }
const run = (...args: string[]) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' })
const STATUS = (...lines: string[]) => file('STATUS.md', ['Aim: x', ...lines, ''].join('\n'))

test('statusmd: an intent prefix that is not exactly one stored intent@1 Artifact is a problem', () => {
  const stored = file('intents.txt', [sha('abc123def456'), sha('abc123def457'), sha('777777777777')].join('\n') + '\n')
  const ok = run(STATUS('- [ ] a-1 One (intent: 777777777777)'), '--intents', stored)
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /no problems/)
  assert.doesNotMatch(ok.stdout, /note:/)

  const unknown = run(STATUS('- [ ] a-1 One (intent: 000000000000)'), '--intents', stored)
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /line 2: Item a-1 names intent 000000000000, which is not a stored intent@1 Artifact/)

  const ambiguous = run(STATUS('- [ ] a-1 One (intent: abc123def456)'), '--intents', file('amb.txt', [sha('abc123def456'), sha('abc123def456'.slice(0, 11) + '6' + 'f')].join('\n')))
  assert.equal(ambiguous.status, 1)
  assert.match(ambiguous.stderr, /intent abc123def456, which matches 2 stored Artifacts/)
})

test('statusmd: without a reachable store the intent check is skipped and says so; an Item without intent needs no store', () => {
  const skipped = run(STATUS('- [ ] a-1 One (intent: 000000000000)'))
  assert.equal(skipped.status, 0, skipped.stderr)
  assert.match(skipped.stdout, /note: 1 intent prefix not checked/)
  const plain = run(STATUS('- [ ] a-1 One', '- [ ] a-2 Two (after: a-1)'))
  assert.equal(plain.status, 0, plain.stderr)
  assert.doesNotMatch(plain.stdout, /note:/)
  const bad = run(STATUS('- [ ] a-1 One (after: a-9)'))
  assert.equal(bad.status, 1)
})
