/**
 * The Node a repository asks for (PROP-0007 decision 3), for the PATH of a check and of a Worker alike (fl-3): a Worker whose PATH has an older
 * Node runs `bin/system` into "needs Node >=24.9" and its tests wait out their timeouts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

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
