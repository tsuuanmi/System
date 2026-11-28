/**
 * rt-4 (ADR-0018 decisions 3 to 5) through a real Host: a profile that patches the old rows `agents` or `web-worker` is refused at
 * `system host` and `system doctor`, naming both rows and printing the new ones; a profile with the new rows lists the `web` Accounts
 * through `system workers`.
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fakeAgent, systemCli } from '../test-support/cli.ts'

const cli = systemCli('system-migration')
const { home } = cli
after(async () => {
  await cli.stop()
  rmSync(home, { recursive: true, force: true })
})
const patch = (text: string) => writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), text)

const OLD = `- id: agents
  config:
    accounts:
      - {ref: claude-code/default, runtime: claude-code, capabilities: [research], command: ${fakeAgent}}
      - {ref: web/chatgpt/default, runtime: web, site: chatgpt, capabilities: [research.lane-a]}
- id: web-worker
  disabled: false
`

test('a Host on a profile with the old row ids refuses to start, naming both rows and printing the new rows', () => {
  assert.equal(cli.run(['init']).status, 0)
  patch(OLD)
  for (const command of ['host', 'doctor']) {
    const ran = cli.run([command], { timeoutMs: 60_000 })
    assert.equal(ran.status, 1, `${command}: ${ran.stdout}${ran.stderr}`)
    assert.match(ran.stderr, /\bagents\b/)
    assert.match(ran.stderr, /\bweb-worker\b/)
    assert.match(ran.stderr, /- id: runtime-cli/)
    assert.match(ran.stderr, /- id: runtime-web/)
    assert.match(ran.stderr, /ref: web\/chatgpt\/default/)
  }
})

test('a profile with a web Account under the CLI row is refused too', () => {
  patch(`- id: runtime-cli\n  config:\n    accounts:\n      - {ref: web/chatgpt/default, runtime: web, site: chatgpt, capabilities: [research.lane-a]}\n`)
  const ran = cli.run(['doctor'], { timeoutMs: 60_000 })
  assert.equal(ran.status, 1, ran.stdout)
  assert.match(ran.stderr, /web\/chatgpt\/default/)
  assert.match(ran.stderr, /- id: runtime-web/)
})

test('a Host on the new rows lists the web Accounts through system workers', async () => {
  mkdirSync(join(home, 'system', 'codex', 'default'), { recursive: true })
  patch(`- id: runtime-cli
  config:
    $patch: replace
    accounts:
      - {ref: claude-code/default, runtime: claude-code, capabilities: [research], command: ${fakeAgent}}
- id: runtime-web
  disabled: false
  config:
    accounts:
      - {ref: web/chatgpt/default, runtime: web, site: chatgpt, capabilities: [research.lane-a]}
      - {ref: web/chatgpt/second, site: chatgpt, capabilities: [research.lane-b]}
`)
  await cli.start()
  const out = cli.run(['workers'])
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /web\/chatgpt\/default\s+\S+.*\(web\)\n\s+abilities: web\.search, web\.browse\n\s+capabilities: research\.lane-a/)
  assert.match(out.stdout, /web\/chatgpt\/second\s+\S+.*\(web\)/)
  assert.match(out.stdout, /quota: unreadable - a web account has no quota reader/)
  assert.match(out.stdout, /claude-code\/default\s+\S+.*\(claude-code\)/)
})
