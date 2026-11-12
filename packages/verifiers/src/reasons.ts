/**
 * What a check needs besides its command (PROP-0007 decisions 3 and 4): the
 * Node the repository asks for, and one line saying why it failed, read from
 * the output of Node's test runner (its `spec` reporter).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

type Version = [number, number, number]
const parse = (text: string): Version | undefined => {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text.trim())
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : undefined
}
const compare = (a: Version, b: Version) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** Whether `version` satisfies `range`: space-separated `>=x.y.z`, `>x.y.z`, `<x.y.z`, `<=x.y.z`, `^x.y.z` or `x[.y[.z]]`, all of them. */
export function satisfies(version: string, range: string): boolean {
  const v = parse(version)
  if (!v) return false
  return range.trim().split(/\s+/).every((part) => {
    const m = /^(>=|<=|>|<|\^|=)?(.+)$/.exec(part)!
    const want = parse(m[2]!)
    if (!want) return false
    const c = compare(v, want)
    switch (m[1]) {
      case '>=': return c >= 0
      case '>': return c > 0
      case '<=': return c <= 0
      case '<': return c < 0
      case '^': return v[0] === want[0] && c >= 0
      default: return m[2]!.split('.').every((n, i) => Number(n) === v[i])
    }
  })
}

/**
 * The `bin` directory of a Node that satisfies the `engines.node` of the
 * repository at `worktree`: this process's own when it does, else the newest
 * under `nodes` (nvm's layout, as `bin/system` looks). Undefined when the
 * repository names no Node; an error when none installed satisfies it.
 */
export function nodeBin(worktree: string, nodes = join(homedir(), '.nvm', 'versions', 'node')): string | undefined {
  let range: string | undefined
  try {
    range = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8'))?.engines?.node
  } catch {
    return undefined
  }
  if (typeof range !== 'string') return undefined
  if (satisfies(process.versions.node, range)) return dirname(process.execPath)
  const found = (existsSync(nodes) ? readdirSync(nodes) : [])
    .filter((name) => satisfies(name, range!) && existsSync(join(nodes, name, 'bin', 'node')))
    .sort((a, b) => compare(parse(b)!, parse(a)!))[0]
  if (!found) throw new Error(`no installed Node satisfies engines.node ${range} (this is ${process.version}; looked in ${nodes})`)
  return join(nodes, found, 'bin')
}

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
  return interruptedTests(output).map((t) => t.label)
}

/** The files with a failing test in Node's `spec` output (all of them, not only the first). */
export function failingFiles(output: string): string[] {
  const lines = output.split('\n')
  const start = lines.findIndex((l) => l.startsWith('✖ failing tests:'))
  if (start < 0) return []
  return [...new Set(lines.slice(start + 1).filter((l) => l.startsWith('test at ')).map((l) => fileOf(l.slice('test at '.length))))]
}

/** The files of the tests a runner was running when it was interrupted. */
export const interruptedFiles = (output: string): string[] => [...new Set(interruptedTests(output).map((t) => t.file))]

function interruptedTests(output: string): { file: string; label: string }[] {
  const lines = output.split('\n')
  const start = lines.findIndex((l) => l.startsWith('Interrupted while running:'))
  if (start < 0) return []
  const running: { file: string; label: string }[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) { if (running.length) break; continue }
    const m = /^\s*⚠ (.*) \((.*)\)$/.exec(line)
    if (!m) break
    const file = fileOf(m[2]!)
    running.push({ file, label: m[1] === file ? file : `${file} "${m[1]}"` })
  }
  return running
}
