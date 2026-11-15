/**
 * What a check needs besides its command (PROP-0007 decision 4): one line saying why it failed, read from
 * the output of Node's test runner (its `spec` reporter). The Node the repository asks for (decision 3) is `nodeBin` of `@system/agents`, which a Worker's PATH uses too (fl-3).
 */
import { basename } from 'node:path'

export { nodeBin, satisfies } from '@system/agents'

/** The file a test runner location names: `test at file:///a/b.test.ts:3:1` gives `b.test.ts`. */
const fileOf = (location: string) => basename(location.replace(/:\d+:\d+$/, ''))

/** The first line of an error, without its class; a line ending in `:` takes the next one too (an assertion's diff). */
function firstErrorLine(lines: string[]): string {
  const text = lines.map((l) => l.trim()).filter(Boolean)
  const first = (text[0] ?? '').replace(/^\w*Error(?: \[\w+\])?: /, '').replace(/^'(.*)'$/, '$1')
  return first.endsWith(':') && text[1] && !text[1].startsWith('at ') ? `${first} ${text[1]}` : first
}

/** The first failing test in Node's `spec` output: `file "test": first error line`, or undefined. */
export function firstFailure(output: string): string | undefined {
  const lines = output.split('\n')
  const start = lines.findIndex((l) => l.startsWith('✖ failing tests:'))
  if (start < 0) return undefined
  const at = lines.findIndex((l, i) => i > start && l.startsWith('test at '))
  const name = /^✖ (.*) \([\d.]+m?s\)$/.exec(lines[at + 1] ?? '')?.[1]
  if (at < 0 || !name) return undefined
  const file = fileOf(lines[at]!.slice('test at '.length))
  const error = lines.slice(at + 2).findIndex((l) => !l.startsWith('  ') && l.trim() !== '')
  const body = lines.slice(at + 2, error < 0 ? undefined : at + 2 + error)
  const what = firstErrorLine(body)
  return `${name === file ? file : `${file} "${name}"`}${what ? `: ${what}` : ''}`
}

/** The tests Node's test runner was running when it was interrupted (it prints them on SIGINT). */
export function interrupted(output: string): string[] {
  const lines = output.split('\n')
  const start = lines.findIndex((l) => l.startsWith('Interrupted while running:'))
  if (start < 0) return []
  const running: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) { if (running.length) break; continue }
    const m = /^\s*⚠ (.*) \((.*)\)$/.exec(line)
    if (!m) break
    const file = fileOf(m[2]!)
    running.push(m[1] === file ? file : `${file} "${m[1]}"`)
  }
  return running
}
