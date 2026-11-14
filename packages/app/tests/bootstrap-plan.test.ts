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
  assert.deepEqual(checks.map((c) => c.run), ['npm ci', 'npm test\nnpm run lint\n'])
  assert.equal(new Set(checks.map((c) => c.name)).size, 2)
  assert.ok(plan.notTranslated.some((l) => l.startsWith('not translated: ci/test/') && /uses/.test(l)))
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
  const order = ['branch dev main', 'commit', 'push', 'bootstrap check'].map((s) => commands.indexOf(s))
  assert.ok(order.every((i) => i >= 0), commands)
  assert.deepEqual(order, [...order].sort((a, b) => a - b))
  assert.match(text, /create .*docs\/governance\/documentation\.md/)
  assert.equal(readdirSync(dir, { recursive: true }).join() + execFileSync('git', ['-C', dir, 'for-each-ref'], { encoding: 'utf8' }), before)
})
