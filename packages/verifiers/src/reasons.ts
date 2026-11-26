/**
 * What a check needs besides its command (PROP-0007 decision 4): one line saying why it failed, read from
 * the output of Node's test runner (its `spec` reporter). The Node the repository asks for (decision 3) is `nodeBin` of `@system/agents`, which a Worker's PATH uses too (fl-3).
 */
import { basename } from 'node:path'

import { maskValues } from '@system/agents'

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

/** The most a check's own output adds to a verdict's reason. */
const OWN_ERROR_MAX = 300

/** The last non-empty lines of `text` that fit in `OWN_ERROR_MAX` characters, on one line, each `secrets` value masked. */
export function lastLines(text: string, secrets: readonly string[] = []): string {
  const clean = maskValues(text, secrets)
  const lines = clean.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  const picked: string[] = []
  let size = 0
  for (const line of lines.reverse()) {
    const next = size + line.length + (picked.length ? 3 : 0)
    if (next > OWN_ERROR_MAX) {
      if (!picked.length) picked.push(line.slice(-OWN_ERROR_MAX))
      break
    }
    picked.unshift(line)
    size = next
    if (picked.length >= 3) break
  }
  return picked.join(' | ')
}

/** Lines a package manager prints while installing (pnpm, npm): never the reason a check failed. */
const INSTALL_NOISE = /^(Progress: |Lockfile is up to date|Already up to date|Scope: |Packages: |Downloading |Done in |[+-]{3,}$|dependencies:$|devDependencies:$|\+ \S+ \S+$|WARN |npm warn |added \d+ packages|up to date,)/

/** `text` without install noise, unless nothing else is left (an `install` check's own output is then its reason). */
const withoutNoise = (text: string): string => {
  const kept = text.split('\n').filter((l) => !INSTALL_NOISE.test(l.trim()))
  return kept.some((l) => l.trim()) ? kept.join('\n') : text
}

/**
 * Why a check that exited non-zero failed: its first failing test (`unit: a.test.ts "x": boom`, which rb-3 keys on), else
 * the last lines of its stderr (else stdout), else `name (exit N)`. `output` is stdout and stderr together, as the test runner prints.
 */
export function failureLine(output: string, name: string, exitCode: number | null, signal: string | null, own: { stderr: string; stdout: string } | string, secrets: readonly string[] = []): string {
  const first = firstFailure(output)
  if (first) return `${name}: ${first}`
  const text = typeof own === 'string' ? own : own.stderr.trim() ? own.stderr : own.stdout
  const last = lastLines(withoutNoise(text), secrets)
  return last ? `${name}: ${last}` : `${name} (exit ${exitCode ?? signal})`
}
