/**
 * Credential-gated: one Research Work on the operator's own signed-in
 * `chatgpt-web/default` profile (`system workers login chatgpt-web/default`),
 * in a throwaway home whose only account is that one. Skipped unless
 * SYSTEM_REAL_WEB=1. Opens a real chat on chatgpt.com.
 *
 *   SYSTEM_REAL_WEB=1 node --test tests/real-web.test.ts
 *
 * The profile is $SYSTEM_WEB_PROFILE, else $DSH_HOME/system/chatgpt-web/default
 * of the operator's home (~/.dsh unless DSH_HOME is set).
 */
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { writeFileSync } from 'node:fs'
import { systemCli } from '../test-support/cli.ts'

const enabled = process.env.SYSTEM_REAL_WEB === '1'
const profile = process.env.SYSTEM_WEB_PROFILE || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'system', 'chatgpt-web', 'default')
const cli = systemCli('system-real-web')
const { home } = cli
const system = (args: string[], input?: string) => cli.run(args, { input, timeoutMs: 1_200_000 })

before(async () => {
  if (!enabled) return
  assert.equal(system(['init']).status, 0)
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), `- id: web-worker
  disabled: false
- id: agents
  config:
    accounts:
      - ref: chatgpt-web/default
        runtime: chatgpt-web
        capabilities: [research, web-search]
        profileDir: ${profile}
        procedures: generic
`)
  await cli.start()
})

after(async () => {
  await cli.stop()
})

test('a Research Work runs on chatgpt-web/default and its sources are checked', { skip: !enabled && 'set SYSTEM_REAL_WEB=1', timeout: 1_500_000 }, () => {
  assert.match(system(['workers']).stdout, /chatgpt-web\/default\s+available/)
  const question = system(['task', 'new', '--text', 'What is the capital of France? Cite one page that says so.']).stdout.trim().split('\n').at(-1)!
  const ran = system(['work', 'submit', '--workflow', join(import.meta.dirname, '..', 'workflows', 'research.yaml'), '--input', question])
  assert.ok([0, 3].includes(ran.status ?? -1), ran.stderr + ran.stdout)
  const record = JSON.parse(system(['work', 'show', ran.stdout.trim().split('\n')[0]!]).stdout) as { events: { type: string; worker?: { ref: string }; status?: string; stepId?: string }[] }
  const observed = record.events.filter((e) => e.type === 'observed' && e.stepId === 'investigate')
  assert.equal(observed.at(-1)?.worker?.ref, 'chatgpt-web/default')
  assert.equal(observed.at(-1)?.status, 'succeeded')
})
