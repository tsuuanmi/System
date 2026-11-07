// Ported from System 1 (tsuuanmi/system @ f199a277): packages/ui-ops/tests/heal.spec.ts, vitest to node:test. Changes: packages/web-driver/README.md.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { choose, parseAiSnapshot, scoreNodes } from '../src/ui-ops/heal.ts'

// Shape produced by patchright-core 1.63 `ariaSnapshot({ mode: 'ai' })` (pinned by engine.test.ts).
const SNAPSHOT = `- generic [ref=e1]:
  - textbox "Message" [ref=e2]
  - button "Voice mode" [ref=e3]: 🎤
  - button "Send message" [ref=e4]: ↑
- button "Send feedback" [ref=e5]`

describe('self-heal matcher', () => {
  it('parses refs, roles, names, and parents', () => {
    const nodes = parseAiSnapshot(SNAPSHOT)
    assert.deepEqual(nodes.map((n) => [n.ref, n.role, n.name, n.parent]), [
      ['e1', 'generic', '', undefined], ['e2', 'textbox', 'Message', 0], ['e3', 'button', 'Voice mode', 0],
      ['e4', 'button', 'Send message', 0], ['e5', 'button', 'Send feedback', undefined],
    ])
  })

  it('refuses a line of a long run after its role, or an unclosed name, in linear time (no polynomial backtracking)', () => {
    const started = performance.now()
    assert.deepEqual(parseAiSnapshot(`- a${'-'.repeat(100_000)}`), [])
    assert.deepEqual(parseAiSnapshot(`- button "${'\\"'.repeat(100_000)}`), [])
    assert.deepEqual(parseAiSnapshot(`- button "${'a'.repeat(100_000)}" [ref=e9]`).map((n) => [n.ref, n.name.length]), [['e9', 100_000]])
    assert.ok(performance.now() - started < 1000)
  })

  it('prefers the role and name match next to the composer, and needs a clear lead', () => {
    const scored = scoreNodes(parseAiSnapshot(SNAPSHOT), { role: 'button', name: { en: 'send' }, nearRole: 'textbox' }, ['en'])
    assert.partialDeepStrictEqual(scored[0], { ref: 'e4', score: 1 })
    assert.equal(scored.find((s) => s.ref === 'e5')!.score, 0.9)
    assert.equal(choose(scored), undefined) // e4 (1.0) vs e5 (0.9): not a clear winner
    assert.equal(choose(scored, { margin: 0.05 })?.ref, 'e4')
  })

  it('never scores a node of another role', () => {
    const scored = scoreNodes(parseAiSnapshot(SNAPSHOT), { role: 'link', name: { en: 'send' } }, ['en'])
    assert.deepEqual(scored, [])
  })
})
