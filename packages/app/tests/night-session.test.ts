import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { Command } from 'commander'
import { buildProgram, type ClientHost } from '../src/cli.ts'
import { tools } from '../src/mcp.ts'

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
  // Only the wait runs in Bash: `work submit --no-run` would admit and never run, and a following `work submit` outlives a Bash call.
  // `--timeout` is in minutes: 90 seconds, so one wait ends inside a Bash call (2 minutes by default).
  const wait = lines.map((l) => /^system work wait \S+ --timeout (\S+)$/.exec(l)?.[1]).find(Boolean)
  assert.ok(wait, 'waits with a timeout')
  assert.ok(Number(wait) * 60 <= 100, `the wait of ${wait} minutes ends inside a Bash call`)
  assert.ok(!lines.some((l) => /^system work submit\b/.test(l)), 'submits through the MCP tool')
  assert.doesNotMatch(file, /--no-run/)
})

/** The MCP tool names as Claude Code shows them: `mcp__system__<tool with _ for .>`. */
const claudeName = (tool: string) => `mcp__system__${tool.replace(/\./g, '_')}`
const named = (text: string) => [...new Set(text.match(/mcp__system__\w+/g) ?? [])].sort()

test('the night session prompt names the MCP tools of its sequence, and each exists and is open to agents', () => {
  const exists = new Set(tools.map((t) => claudeName(t.name)))
  const used = named(file)
  for (const needed of ['item_claim', 'task_new', 'work_submit', 'work_show', 'work_report', 'work_list', 'status', 'artifact_put', 'artifact_show', 'artifact_cat'])
    assert.ok(used.includes(`mcp__system__${needed}`), needed)
  for (const name of used) assert.ok(exists.has(name), `no such MCP tool: ${name}`)
})

test('the night session prompt names no MCP tool that approves, denies, cancels, retries or releases', () => {
  for (const name of named(file)) assert.doesNotMatch(name, /approv|deny|decide|cancel|retry|release|run$|replay|credentials|login/, name)
})

test('the prompt passes task text and the report as tool arguments or single-quoted files, never a backtick shell string', () => {
  assert.doesNotMatch(file, /system task new/)
  assert.doesNotMatch(file, /system artifact put/)
  assert.doesNotMatch(file, /<<'?(TASK|REPORT)/)
})

test('every system command and option the night session prompt names exists in the CLI', () => {
  const lines = systemLines(file)
  assert.ok(lines.length >= 1, 'the prompt shows its commands in code blocks')
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

/** The text from the `## The night report` heading to the end of the file. */
const reportSection = file.slice(file.indexOf('## The night report'))

test('the night report is one Artifact with the required parts, read from work report', () => {
  const lines = systemLines(file)
  assert.match(reportSection, /mcp__system__work_report/)
  assert.match(reportSection, /mcp__system__artifact_put/)
  assert.match(reportSection, /text\/markdown/)
  assert.match(reportSection, /base64/)
  for (const part of ['Works', 'Items done', 'Items skipped', 'no Item', 'Items you propose', 'For the operator', 'Account', 'cost'])
    assert.ok(reportSection.includes(part), `the report names: ${part}`)
  assert.match(reportSection, /system work approve <work>/)
  assert.doesNotMatch(reportSection, /ss-3 will say/)
})

test('the notifier is optional and comes from the environment, never a secret in the file', () => {
  assert.match(reportSection, /SYSTEM_NIGHT_NOTIFY_URL/)
  assert.match(reportSection, /SYSTEM_NIGHT_NOTIFY_COMMAND/)
  assert.match(reportSection, /(none|neither|not set|unset)[^.]*(journal|output)/i)
  assert.doesNotMatch(file, /https?:\/\/(?!claude\.com)\S*(ntfy\.sh|hooks\.)\S+/)
  // every notifier line is guarded: it runs only when its variable is set
  for (const line of file.split('\n').filter((l) => /curl .*NOTIFY|\$SYSTEM_NIGHT_NOTIFY_COMMAND/.test(l)))
    assert.match(line, /\[ -n "\$\{?SYSTEM_NIGHT_NOTIFY_\w+(:-)?\}?" \]|\$\{SYSTEM_NIGHT_NOTIFY_\w+:\+/, line)
})
