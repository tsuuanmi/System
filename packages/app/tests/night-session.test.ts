import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { Command } from 'commander'
import { buildProgram, type ClientHost } from '../src/cli.ts'

const file = readFileSync(new URL('../../../tools/night-session.md', import.meta.url), 'utf8')
const program = buildProgram({} as unknown as ClientHost, { out() {}, err() {} } as any, () => {})

/** Every line of the fenced code blocks that starts with `system `. */
function systemLines(text: string): string[] {
  const lines: string[] = []
  let fenced = false
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) fenced = !fenced
    else if (fenced && /^\s*system\s/.test(line)) lines.push(line.trim())
  }
  return lines
}

test('the night session prompt shows the commands it drives', () => {
  const lines = systemLines(file)
  for (const needed of ['system status', 'system claim', 'system task new', 'system work submit', 'system work wait', 'system work show', 'system artifact show'])
    assert.ok(lines.some((l) => l.startsWith(needed)), needed)
})

test('every system command and option the night session prompt names exists in the CLI', () => {
  const lines = systemLines(file)
  assert.ok(lines.length >= 6, 'the prompt shows its commands in code blocks')
  for (const line of lines) {
    const words = line.split(/\s+/).slice(1)
    let command: Command = program
    let i = 0
    for (; i < words.length; i += 1) {
      const next = command.commands.find((c) => c.name() === words[i])
      if (!next) break
      command = next
    }
    assert.notEqual(command, program, `no such command: ${line}`)
    if (command.commands.length > 0) assert.fail(`a group, not a command: ${line}`)
    const known = new Set(command.options.flatMap((o) => [o.long, o.short]).filter(Boolean))
    for (const word of words.slice(i)) {
      const flag = /^(--?[A-Za-z][\w-]*)/.exec(word)?.[1]
      if (flag) assert.ok(known.has(flag), `${command.name()} has no option ${flag}: ${line}`)
    }
  }
})

test('the night session prompt never uses the operator-only commands', () => {
  for (const line of systemLines(file)) {
    assert.doesNotMatch(line, /^system\s+(approve|deny|work\s+(approve|deny|retry|cancel)|release|update)\b/, line)
  }
})
