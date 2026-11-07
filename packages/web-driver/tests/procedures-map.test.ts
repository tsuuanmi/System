/**
 * `ui-map@1.7` for the generic Procedures (WW2-ii): the kinds `site`, `modes`, `answer` and `settings`,
 * checked at load, before any browser opens. No Chrome here; the Procedures on a page are in conformance.test.ts.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { bindingProblems } from '../src/procedures.ts'
import { DEFAULT_SETTINGS, loadUiMap } from '../src/ui-ops/index.ts'

const read = (name: string): string => readFileSync(new URL(`../ui/${name}`, import.meta.url), 'utf8')
const BASE = `
schema: ui-map@1.7
provider: test-site
uiRevision: '2026-11-08'
locales: [en]
elements:
  composer.input: { candidates: [{ css: 'textarea' }] }
  turn.assistant: { cardinality: many, candidates: [{ css: '.a' }] }
  turn.user: { cardinality: many, candidates: [{ css: '.u' }] }
  mode.chat: { candidates: [{ css: '.chat' }] }
  mode.work: { candidates: [{ css: '.work' }] }
  mode.group: { candidates: [{ css: '.modes' }] }
  mode.pick: { candidates: [{ css: '.chat' }] }
  temporary.toggle: { candidates: [{ css: '.temp' }] }
  answer.error: { candidates: [{ css: '.err' }] }
  status.done: { candidates: [{ css: '.done' }] }
actions:
  temporary.enable: { do: click, target: temporary.toggle, verify: { visible: composer.input }, sideEffect: reversible }
  mode.select-chat: { do: click, target: mode.pick, verify: { state: mode.chat-selected }, sideEffect: reversible }
states:
  auth.signed-in: { visible: composer.input }
  mode.chat-selected: { attr: { of: mode.chat, name: aria-pressed, equals: 'true' } }
  mode.work-selected: { attr: { of: mode.work, name: aria-pressed, equals: 'true' } }
  answer.site-error: { visible: answer.error }
  answer.finished: { visible: status.done }
`
const SITE = `site:\n  origin: 'https://chat.example'\n  conversationUrl: '^/chat/([0-9a-f]+)$'\n  temporaryChat: { action: temporary.enable }\n`
const MODES = `modes:\n  switch: mode.group\n  required: mode.chat-selected\n  forbidden: [mode.work-selected]\n  select: mode.select-chat\n`
const ANSWER = `answer:\n  turn: turn.assistant\n  userTurn: turn.user\n  container: parent\n  prefix: '^Bot said:'\n  done: answer.finished\n  error: answer.site-error\n  leakedTokens: ['<x>']\n`
const full = (extra = ''): string => BASE.replace('elements:', () => `${SITE}${MODES}${ANSWER}${extra}elements:`)

describe('ui-map@1.7 kinds for the Procedures', () => {
  it('loads site, modes and answer, and the new settings default', () => {
    const map = loadUiMap(full('settings: { signedOutHoldMs: 100 }\n'))
    assert.equal(map.site?.origin, 'https://chat.example')
    assert.deepEqual(map.site?.temporaryChat, { action: 'temporary.enable' })
    assert.equal(map.modes?.required, 'mode.chat-selected')
    assert.deepEqual(map.modes?.forbidden, ['mode.work-selected'])
    assert.equal(map.answer.turn, 'turn.assistant')
    assert.deepEqual(map.answer.leakedTokens, ['<x>'])
    assert.equal(map.settings.signedOutHoldMs, 100)
    assert.equal(map.settings.sendAckMs, DEFAULT_SETTINGS.sendAckMs)
    assert.equal(map.settings.modeReadyMs, DEFAULT_SETTINGS.modeReadyMs)
  })

  it('still loads a 1.6 map, which has none of them', () => {
    const map = loadUiMap(BASE.replace('ui-map@1.7', 'ui-map@1.6').replace('  answer.site-error: { visible: answer.error }\n', ''))
    assert.equal(map.site, undefined)
    assert.equal(map.modes, undefined)
    assert.deepEqual(map.answer, { leakedTokens: [] })
    assert.ok(bindingProblems(map).length > 0)
  })

  it('refuses a dangling or malformed binding at load', () => {
    const bad = (from: string, to: string, why: RegExp): void => assert.throws(() => loadUiMap(full().replace(from, to)), why)
    bad('action: temporary.enable', 'action: temporary.nope', /unknown action temporary\.nope/)
    bad('required: mode.chat-selected', 'required: mode.nope', /unknown state mode\.nope/)
    bad('forbidden: [mode.work-selected]', 'forbidden: [mode.nope]', /unknown state mode\.nope/)
    bad('switch: mode.group', 'switch: mode.nope', /unknown element mode\.nope/)
    bad('select: mode.select-chat', 'select: mode.nope', /unknown action mode\.nope/)
    bad('turn: turn.assistant', 'turn: turn.nope', /unknown element turn\.nope/)
    bad('done: answer.finished', 'done: answer.nope', /unknown state answer\.nope/)
    bad('error: answer.site-error', 'error: answer.nope', /unknown state answer\.nope/)
    bad("origin: 'https://chat.example'", "origin: 'chat.example'", /ui-map@1\.0/)
    bad('container: parent', 'container: grandparent', /ui-map@1\.0/)
    bad('forbidden: [mode.work-selected]', 'forbidden: [mode.work-selected]\n  other: 1', /ui-map@1\.0/)
    bad("conversationUrl: '^/chat/([0-9a-f]+)$'", "conversationUrl: '['", /conversationUrl/)
    bad("prefix: '^Bot said:'", "prefix: '('", /prefix/)
  })

  it('a required mode needs its switch, its forbidden modes and no way to select a forbidden one', () => {
    assert.throws(() => loadUiMap(full().replace('  switch: mode.group\n', '')), /ui-map@1\.0/)
  })

  it('names what a map still lacks before a browser opens', () => {
    const lacking = bindingProblems(loadUiMap(BASE))
    assert.ok(lacking.some((p) => /site/.test(p)))
    assert.ok(lacking.some((p) => /answer\.turn/.test(p)))
    assert.ok(lacking.some((p) => /composer\.send/.test(p)))
  })

  it('has the countAtLeast condition for a done marker per turn', () => {
    const map = loadUiMap(full().replace('answer.finished: { visible: status.done }', 'answer.finished: { countAtLeast: { of: status.done, as: turn.assistant } }'))
    assert.deepEqual(map.states['answer.finished'], { countAtLeast: { of: 'status.done', as: 'turn.assistant' } })
    assert.throws(() => loadUiMap(full().replace('answer.finished: { visible: status.done }', 'answer.finished: { countAtLeast: { of: status.done, as: turn.nope } }')), /unknown element turn\.nope/)
  })

  it('binds the attachment chip: its element, the one while it is added, and where its label is read', () => {
    const attach = "attach:\n  chip: status.done\n  adding: answer.error\n  label: text\n"
    const map = loadUiMap(full(attach))
    assert.deepEqual(map.attach, { chip: 'status.done', adding: 'answer.error', label: 'text' })
    assert.equal(loadUiMap(full()).attach, undefined)
    const bad = (from: string, to: string, why: RegExp): void => assert.throws(() => loadUiMap(full(attach).replace(from, to)), why)
    bad('chip: status.done', 'chip: status.nope', /unknown element status\.nope/)
    bad('adding: answer.error', 'adding: answer.nope', /unknown element answer\.nope/)
    bad('label: text', 'label: title', /ui-map@1\.0/)
  })

  it('has the attr condition with a pattern, for a label that names a mode', () => {
    const map = loadUiMap(full().replace('mode.work-selected: {', "mode.work-composer: { attr: { of: composer.input, name: aria-label, matches: '\\bWork\\b' } }\n  mode.work-selected: {"))
    assert.deepEqual(map.states['mode.work-composer'], { attr: { of: 'composer.input', name: 'aria-label', matches: '\\bWork\\b' } })
    assert.throws(() => loadUiMap(full().replace('mode.work-selected: {', "mode.work-composer: { attr: { of: composer.input, name: aria-label, matches: '(' } }\n  mode.work-selected: {")), /matches/)
  })

  it('the shipped maps and the hostile Site bind every Procedure', () => {
    for (const file of ['chatgpt-web.ui.yaml', 'fake-other.ui.yaml']) assert.deepEqual(bindingProblems(loadUiMap(read(file))), [], file)
  })
})
