import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { parseChecksFile } from '../../verifiers/lib/checks.js'
import { bootstrapPlan } from '../src/bootstrap-plan.ts'

const roots: string[] = []
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

function repository(workflows: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-plan-'))
  roots.push(dir)
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  for (const [name, text] of Object.entries(workflows)) writeFileSync(join(dir, '.github', 'workflows', name), text)
  return dir
}

const PLAIN = `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install deps
        run: npm ci
      - name: Build
        run: npm run build
      - name: Run tests
        run: |
          npm test
          npm run lint
`
const MATRIX = `name: Release
on: [push]
jobs:
  publish:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - name: Publish
        run: npm publish
        env:
          TOKEN: \${{ secrets.NPM_TOKEN }}
      - name: Echo
        run: echo \${{ matrix.node }}
`
const USES_ONLY = `name: Pages
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/deploy-pages@v4
`

test('plain run steps are translated into a draft that passes the checks schema', async () => {
  const dir = repository({ 'ci.yml': PLAIN })
  const plan = await bootstrapPlan(dir)
  assert.ok(plan.draft)
  const parsed = parseChecksFile(plan.draft!)
  assert.ok(!('problem' in parsed), JSON.stringify(parsed))
  const checks = (parsed as { checks: { name: string; run: string }[] }).checks
  assert.deepEqual(checks.map((c) => c.run), ['npm run build', 'npm test\nnpm run lint\n'])
  assert.equal(new Set(checks.map((c) => c.name)).size, 2)
  assert.ok(plan.notTranslated.some((l) => l.startsWith('not translated: ci/test/') && /uses/.test(l)))
})

const DNA = `name: CI
on: [push]
jobs:
  rust:
    runs-on: ubuntu-latest
    steps:
      - name: Install tool
        run: cargo install cargo-nextest
      - name: Toolchain
        run: rustup toolchain install stable
      - name: Target
        run: rustup target add wasm32-unknown-unknown
      - name: Test
        run: tools/gates.sh rust-test
`
const NPM = `name: Node
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Install
        run: npm ci
      - name: Test
        run: npm test
`

test('install and setup steps are listed as setup, not a check, and left out of the draft', async () => {
  const plan = await bootstrapPlan(repository({ 'ci.yml': DNA }))
  const checks = (parseChecksFile(plan.draft!) as { checks: { run: string }[] }).checks
  assert.deepEqual(checks.map((c) => c.run), ['tools/gates.sh rust-test'])
  assert.deepEqual(plan.setup, [
    'setup, not a check: ci/rust/Install tool: cargo install cargo-nextest',
    'setup, not a check: ci/rust/Toolchain: rustup toolchain install stable',
    'setup, not a check: ci/rust/Target: rustup target add wasm32-unknown-unknown',
  ])
  assert.deepEqual(plan.notTranslated, [])
  for (const line of plan.setup) assert.ok(plan.text.includes(line + '\n'), line)
})

test('an npm job drafts npm test only', async () => {
  const plan = await bootstrapPlan(repository({ 'node.yml': NPM }))
  const checks = (parseChecksFile(plan.draft!) as { checks: { run: string }[] }).checks
  assert.deepEqual(checks.map((c) => c.run), ['npm test'])
  assert.deepEqual(plan.setup, ['setup, not a check: node/test/Install: npm ci'])
})

test('a job of setup steps only gives no draft', async () => {
  const text = 'name: S\non: [push]\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: corepack enable\n      - run: pip install -r requirements.txt\n'
  const plan = await bootstrapPlan(repository({ 's.yml': text }))
  assert.equal(plan.draft, undefined)
  assert.equal(plan.setup.length, 2)
  assert.match(plan.text, /no plain run steps/)
})

test('setup commands mixed with a real command stay a check; templated installs stay not translated', async () => {
  const text = 'name: M\non: [push]\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: |\n          npm ci\n          npm test\n      - run: npm ci ${{ matrix.x }}\n'
  const plan = await bootstrapPlan(repository({ 'm.yml': text }))
  assert.deepEqual(plan.setup, [])
  assert.equal(plan.notTranslated.length, 1)
  assert.match(plan.draft!, /npm test/)
})

test('a matrix with secrets is listed as not translated, step by step', async () => {
  const dir = repository({ 'release.yml': MATRIX })
  const plan = await bootstrapPlan(dir)
  assert.equal(plan.draft, undefined)
  assert.equal(plan.notTranslated.length, 2)
  for (const line of plan.notTranslated) assert.match(line, /^not translated: release\/publish\/.+: .+/)
  assert.match(plan.notTranslated.join('\n'), /matrix/)
})

test('only uses: steps give an empty draft and a note', async () => {
  const dir = repository({ 'pages.yml': USES_ONLY })
  const plan = await bootstrapPlan(dir)
  assert.equal(plan.draft, undefined)
  assert.equal(plan.notTranslated.length, 2)
  assert.match(plan.text, /no plain run steps/)
  assert.match(plan.text, /not translated: pages\/deploy\//)
})

test('the plan prints the sections and the commands in order, and writes nothing', async () => {
  const dir = repository({ 'ci.yml': PLAIN })
  const before = readdirSync(dir, { recursive: true }).join() + execFileSync('git', ['-C', dir, 'for-each-ref'], { encoding: 'utf8' })
  const { text } = await bootstrapPlan(dir)
  const at = ['== files ==', '== checks ==', '== draft .system/checks.yaml ==', '== commands ==']
    .map((h) => { const i = text.indexOf(h); assert.ok(i >= 0, h); return i })
  assert.deepEqual(at, [...at].sort((a, b) => a - b))
  const commands = text.slice(at[3]!)
  const order = ['branch dev main', 'commit', 'STATUS.md', 'Aim:', '- [ ] <id> <title>', 'push', 'bootstrap check'].map((s) => commands.indexOf(s))
  assert.ok(commands.indexOf('git -C', commands.indexOf('Aim:')) < commands.indexOf('push -u'), 'STATUS.md is committed before the push')
  assert.ok(order.every((i) => i >= 0), commands)
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
  assert.match(text, /create .*docs\/governance\/documentation\.md/)
  assert.equal(readdirSync(dir, { recursive: true }).join() + execFileSync('git', ['-C', dir, 'for-each-ref'], { encoding: 'utf8' }), before)
})
