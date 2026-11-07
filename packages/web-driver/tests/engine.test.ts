// Ported from System 1 (tsuuanmi/system @ f199a277): packages/ui-ops/tests/engine.spec.ts, vitest to node:test. Changes: packages/web-driver/README.md.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadUiMap, readbackDiff } from '../src/ui-ops/index.ts'

const MAP = `
schema: ui-map@1.0
provider: test-site
uiRevision: '2026-10-09'
locales: [en, vi]
elements:
  composer.form:
    candidates:
      - { css: 'form[data-type="composer"]' }
  composer.input:
    scope: composer.form
    candidates:
      - { testId: prompt-textarea }
      - { role: textbox }
    fingerprint: { role: textbox }
  composer.send:
    scope: composer.form
    candidates:
      - { testId: send-button }
      - { role: button, name: { en: '^Send prompt$', vi: '^Gửi lời nhắc$' } }
    fingerprint: { role: button, name: { en: 'send', vi: 'gửi' }, nearRole: textbox }
  response.stop:
    candidates: [{ testId: stop-button }]
  turn.user:
    cardinality: many
    candidates: [{ css: '[data-role="user"]' }]
  turn.assistant.last:
    candidates: [{ css: '[data-role="assistant"]:last-of-type' }]
  auth.login:
    candidates: [{ testId: login-button }]
actions:
  composer.insert:
    do: insertText
    target: composer.input
    require: [editable]
    verify: { attr: { of: composer.input, name: data-filled, present: true } }
    sideEffect: none
  composer.send:
    do: click
    target: composer.send
    require: [enabled]
    fallback: { press: Enter, on: composer.input }
    verify: { anyOf: [{ network: conversation.post }, { countIncreased: turn.user }] }
    sideEffect: irreversible
    heal: deterministic
    timeouts: { resolveMs: 1500, verifyMs: 3000 }
network:
  conversation.post: { method: POST, url: '/backend-api/conversation$' }
  stream.open: { url: '/backend-api/conversation$', contentType: text/event-stream, open: true }
states:
  auth.signed-out: { visible: auth.login }
  turn.running: { anyOf: [{ visible: response.stop }, { network: stream.open }] }
  turn.complete: { allOf: [{ not: { state: turn.running } }, { stableTextMs: 300, of: turn.assistant.last }] }
errors:
  - { when: { state: auth.signed-out }, kind: reauth_required }
`

/** A site's usage-limit answer, added by the operator overlay (ADR-0034). */
const LIMIT_OVERLAY = `
elements:
  answer.limit:
    candidates:
      - { text: { en: '^You have reached your Deep research limit' } }
errors:
  - { when: { visible: answer.limit }, kind: quota_exhausted, feature: deep-research, on: answer }
`



describe('readbackDiff: where a composer changed a paste, never what it said', () => {
  it('names the first difference by line, offset, and character class', () => {
    const inserted = 'Review the code:\n\n```ts\nconst secret = 1\n```\nThanks'
    const read = 'Review the code:\n\nts\nconst secret = 1\nThanks'
    assert.deepEqual(readbackDiff(inserted, read), { insertedChars: inserted.length, readChars: read.length, insertedLines: 5, readLines: 4, line: 1, offset: 0, inserted: 'punctuation `', read: 'letter', truncated: false })
    // Structure only: none of the text itself.
    assert.doesNotMatch(JSON.stringify(readbackDiff(inserted, read)), /secret|Review|Thanks/)
  })

  it('says when the text was cut short', () => {
    assert.partialDeepStrictEqual(readbackDiff('one two three\nfour', 'one two'), { line: 0, offset: 7, inserted: 'space', read: 'end', truncated: true })
  })
})

describe('loadUiMap', () => {
  it('validates the map and appends overlay candidates after the shipped ones', () => {
    const shipped = loadUiMap(MAP)
    const overlaid = loadUiMap(MAP, `elements:\n  composer.send:\n    candidates:\n      - { testId: submit-v2 }\n`)
    assert.deepEqual(overlaid.elements['composer.send']!.candidates.at(-1), { testId: 'submit-v2', source: 'overlay' })
    assert.deepEqual(overlaid.elements['composer.send']!.candidates[0], { testId: 'send-button', source: 'shipped' })
    assert.notEqual(overlaid.hash, shipped.hash)
  })

  it('accepts answer.leakedTokens (a list of strings), defaults it to none, and rejects anything else', () => {
    assert.deepEqual(loadUiMap(MAP).answer.leakedTokens, [])
    assert.deepEqual(loadUiMap(MAP.replace('elements:', "answer: { leakedTokens: ['<escape>'] }\nelements:")).answer.leakedTokens, ['<escape>'])
    assert.throws(() => loadUiMap(MAP.replace('elements:', 'answer: { leakedTokens: [1] }\nelements:')))
    assert.throws(() => loadUiMap(MAP.replace('elements:', 'answer: { other: [] }\nelements:')))
  })

  it('rejects an invalid map, an overlay element with no candidate, and an overlay rule naming an unknown element', () => {
    assert.throws(() => loadUiMap(MAP.replace('candidates:\n      - { css', 'candidates: []\n      - { css')))
    assert.throws(() => loadUiMap(MAP, 'elements:\n  answer.limit:\n    candidates: []\n'))
    assert.throws(() => loadUiMap(MAP, 'errors:\n  - { when: { visible: nope }, kind: quota_exhausted }\n'), /unknown element nope/)
  })

  it('adds an overlay\'s own elements and error rules, after the shipped ones, without a release (ADR-0034)', () => {
    const overlaid = loadUiMap(MAP, LIMIT_OVERLAY)
    assert.deepEqual(overlaid.elements['answer.limit'], { candidates: [{ text: { en: '^You have reached your Deep research limit' }, source: 'overlay' }] })
    assert.deepEqual(overlaid.errors, [
      { when: { state: 'auth.signed-out' }, kind: 'reauth_required' },
      { when: { visible: 'answer.limit' }, kind: 'quota_exhausted', feature: 'deep-research', on: 'answer' },
    ])
  })
})
