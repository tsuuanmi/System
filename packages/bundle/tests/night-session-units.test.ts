/** ss-2: the scheduled session's systemd templates and the runbook steps that fill them. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
const repo = join(import.meta.dirname, '..', '..', '..')

const read = (...p: string[]) => readFileSync(join(repo, ...p), 'utf8')
const service = read('packages', 'bundle', 'system-night-session.service')
const timer = read('packages', 'bundle', 'system-night-session.timer')
const runbook = read('docs', 'operations', 'runbook.md')
const section = runbook.slice(runbook.indexOf('## The scheduled session'), runbook.indexOf('## The dev branch'))

test('the service runs claude -p with the prompt file, in the checkout, after the Host answers, into the journal', () => {
  assert.match(service, /^Type=oneshot$/m)
  assert.match(service, /^WorkingDirectory=@REPO@$/m)
  assert.match(service, /^ExecStartPre=.*@REPO@\/bin\/system doctor/m)
  assert.match(service, /^ExecStart=.*claude -p .*@REPO@\/tools\/night-session\.md/m)
  assert.match(service, /^Environment=PATH=@PATH@$/m)
  assert.match(service, /^TimeoutStartSec=/m)
  assert.doesNotMatch(service, /StandardOutput=(?!journal)/, 'output stays in the journal')
})

test('the timer is nightly, not persistent, and not wanted by anything but timers.target', () => {
  assert.match(timer, /^OnCalendar=\*-\*-\* \d\d:\d\d(:\d\d)?$/m)
  assert.match(timer, /^Persistent=false$/m)
  assert.match(timer, /^WantedBy=timers\.target$/m)
})

test('the placeholders of the templates are the ones the runbook install steps replace', () => {
  const marks = (t: string) => new Set(t.match(/@[A-Z]+@/g) ?? [])
  const used = new Set([...marks(service), ...marks(timer)])
  const replaced = new Set([...section.matchAll(/s\|(@[A-Z]+@)\|/g)].map((m) => m[1]))
  assert.deepEqual([...used].sort(), [...replaced].sort())
  assert.ok(used.size > 0)
})

test('the runbook says how to install, enable, read, change the time of and stop it', () => {
  for (const s of ['system-night-session.service', 'daemon-reload', 'enable --now system-night-session.timer', 'journalctl --user -u system-night-session', 'systemctl --user list-timers', 'disable --now system-night-session.timer', 'OnCalendar'])
    assert.ok(section.includes(s), s)
})
