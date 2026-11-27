/**
 * iso-7 Guardrail: no test of the bubblewrap layer passes only where bubblewrap starts. The GitHub runner has unprivileged user namespaces
 * off, so each layer test file runs here in a child `node --test`, without `SYSTEM_REQUIRE_SANDBOX`, twice: with a `bwrap` first on PATH
 * that cannot start, and with no `bwrap` on PATH at all. Every test must pass or skip. The children run at the same time.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const self = 'packages/agents/tests/sandbox-without-bwrap.test.ts'

/** Every test file that exercises the layer or the launcher that starts it. A new such file is added here; the last test keeps the list honest. */
export const LAYER_TEST_FILES = [
  'packages/agents/tests/sandbox.test.ts',
  'packages/bundle/tests/night-session-launcher.test.ts',
  'tests/layer-gate.test.ts',
  'tests/night-session-layer.test.ts',
]

const broken = mkdtempSync(join(tmpdir(), 'system-nobwrap-'))
after(() => rmSync(broken, { recursive: true, force: true }))
writeFileSync(join(broken, 'bwrap'), '#!/bin/sh\necho "bwrap: No permissions to create new namespace" >&2\nexit 1\n')
chmodSync(join(broken, 'bwrap'), 0o755)

const run = promisify(execFile)
const base = { ...process.env }
delete base.SYSTEM_REQUIRE_SANDBOX
// The parent may itself be a test run: its test-runner variables would make the child report to it.
for (const key of Object.keys(base)) if (key.startsWith('NODE_TEST')) delete base[key]
const path = (process.env.PATH ?? '').split(':')
// A directory that holds `bwrap` also holds git and sh, so it is replaced by a directory of links to all of it but `bwrap`.
const without = path.map((d, i) => {
  if (!existsSync(join(d, 'bwrap'))) return d
  const dir = join(broken, `without-${i}`)
  mkdirSync(dir)
  for (const name of readdirSync(d)) if (name !== 'bwrap') try { symlinkSync(join(d, name), join(dir, name)) } catch { /* a link that exists */ }
  return dir
}).join(':')
const hosts = {
  'a bwrap that cannot start': { ...base, PATH: `${broken}:${without}` },
  'no bwrap': { ...base, PATH: without },
}

/** The launcher file puts its own `bwrap` first on PATH in every test (it takes about 3 s a test), so a host without `bwrap` is the same run: one child. */
const hostsOf = (file: string) => (file.endsWith('night-session-launcher.test.ts') ? { 'a bwrap that cannot start': hosts['a bwrap that cannot start'] } : hosts)

// One child per (file, host), all started now so the wall time is the slowest file, not the sum.
const children = new Map<string, Promise<{ code: number; stdout: string; stderr: string }>>()
for (const file of LAYER_TEST_FILES) {
  for (const [name, env] of Object.entries(hostsOf(file))) {
    const args = ['--import', './test-support/clean-git-env.mjs', '--test', '--test-reporter=spec', file]
    children.set(`${file}\0${name}`, run(process.execPath, args, { cwd: repo, env, encoding: 'utf8', maxBuffer: 64 << 20 }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code as number, stdout: String(e.stdout), stderr: String(e.stderr) })))
  }
}

for (const file of LAYER_TEST_FILES) {
  for (const name of Object.keys(hostsOf(file))) {
    test(`${file} passes or skips with ${name}`, async () => {
      const child = await children.get(`${file}\0${name}`)!
      const failed = child.stdout.split('\n').filter((l) => /^\s*✖/.test(l)).join('\n')
      assert.equal(child.code, 0, `failing tests:\n${failed}\n${child.stderr.slice(-2000)}`)
    })
  }
}

test('the list holds every test file that mentions bwrap', () => {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(join(repo, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
      const path = `${dir}/${e.name}`.replace(/^\.\//, '')
      if (e.isDirectory()) walk(path)
      else if (/\.test\.ts$/.test(e.name) && path !== self && /bwrap/.test(readFileSync(join(repo, path), 'utf8'))) found.push(path)
    }
  }
  for (const dir of ['tests', ...readdirSync(join(repo, 'packages')).map((p) => `packages/${p}/tests`)]) { try { walk(dir) } catch { /* no tests directory */ } }
  assert.deepEqual([...found].sort(), [...LAYER_TEST_FILES].sort(), `${relative(repo, self)} lists the layer test files`)
})
