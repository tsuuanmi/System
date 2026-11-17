// Guardrail (Item ns-2, fl-3's recurring cause): a spawn of `node`, `corepack` or `pnpm` by bare name takes whichever Node is first on
// PATH, which may be too old for `bin/system`. Spawns take `nodeBin(...)` or `process.execPath` (and corepack next to it) instead.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')

function files(dir: string, keep: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'lib') return []
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path, keep) : keep(name) ? [path] : []
  })
}

const PROGRAMS = 'node|corepack|pnpm'
/** A call that spawns, with a bare program as its command argument. */
const SPAWN_CALL = new RegExp(`\\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|run|sh|capture)\\(\\s*['"\`](${PROGRAMS})['"\`]`)
/** In a shell script, a bare program in command position (line start, after `$(`, `;`, `&&`, `|`, `!`) or the start of a quoted command in a list. */
const SHELL_CALL = new RegExp(`(^|[(;&|!]|\\bthen|\\bdo|\\bin\\s+['"]|['"]\\s+['"])\\s*(${PROGRAMS})\\s`)

export function bareSpawns(): string[] {
  const found: string[] = []
  const scan = (path: string, pattern: RegExp, comment: RegExp) =>
    readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
      if (comment.test(line)) return
      if (pattern.test(line)) found.push(`${relative(root, path)}:${i + 1}: ${line.trim()}`)
    })
  const js = [
    ...files(join(root, 'bin'), (n) => n === 'system' || n.endsWith('.mjs')),
    ...readdirSync(join(root, 'packages'), { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => d.name).flatMap((p) => files(join(root, 'packages', p, 'src'), (n) => /\.(ts|mjs|js)$/.test(n))),
    ...files(join(root, 'tools'), (n) => /\.(mjs|ts)$/.test(n)),
  ]
  for (const path of js) scan(path, SPAWN_CALL, /^\s*(\/\/|\*|\/\*)/)
  for (const path of files(join(root, 'tools', 'hooks'), () => true)) scan(path, SHELL_CALL, /^\s*#/)
  return found
}

test('no spawn in bin/, packages/*/src, tools/ or tools/hooks names node, corepack or pnpm bare', () => {
  assert.deepEqual(bareSpawns(), [], 'a bare command takes the PATH\'s Node; use nodeBin(...) or process.execPath (corepack beside it)')
})
