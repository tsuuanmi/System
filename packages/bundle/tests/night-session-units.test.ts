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

test('the service runs the session script, in the checkout, after the Host answers, into the journal', () => {
  assert.match(service, /^Type=oneshot$/m)
  assert.match(service, /^WorkingDirectory=@REPO@$/m)
  assert.match(service, /^ExecStartPre=.*@REPO@\/bin\/system doctor/m)
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

/** ss-8: `claude -p` runs with an allowlist of exactly what the prompt uses. */
const script = read('packages', 'bundle', 'system-night-session.sh')
const prompt = read('tools', 'night-session.md')
const allowed = [...script.matchAll(/(mcp__system__\w+|Bash\([^\n]*?\)(?=['"]?(?:\s|$)))/g)].map((m) => m[1]!)
const mcpAllowed = allowed.filter((r) => r.startsWith('mcp__')).sort()

test('the service starts the script that runs claude -p with --allowedTools and the prompt file', () => {
  assert.match(service, /^ExecStart=@REPO@\/packages\/bundle\/system-night-session\.sh$/m)
  assert.match(script, /claude -p "\$prompt" --output-format text --allowedTools "\$@"/)
  assert.match(script, /prompt=\$\(cat "\$repo\/tools\/night-session\.md"\)/)
})

test('the allowlist holds exactly the MCP tools the prompt names, and the wait', () => {
  assert.deepEqual(mcpAllowed, [...new Set(prompt.match(/mcp__system__\w+/g))].sort())
  assert.ok(allowed.includes('Bash(system work wait:*)'))
})

test('nothing in the allowlist approves, denies, cancels, retries or releases, or writes files or runs a shell', () => {
  for (const rule of allowed) {
    assert.doesNotMatch(rule, /approv|deny|decide|cancel|retry|release|update|credentials|login|work_run|replay/, rule)
    assert.doesNotMatch(rule, /^(Write|Edit|Bash\((bash|git|rm|cat)\b)/, rule)
    assert.doesNotMatch(rule, /^Bash\(sh\b/, 'no shell')
  }
  assert.ok(!allowed.includes('Bash'), 'no bare Bash')
})

test('the allowlist has no artifact_put and no notifier: the launcher stores and sends the report', () => {
  assert.equal(allowed.filter((r) => /artifact_put|curl|sh -c|NOTIFY/.test(r)).length, 0)
  assert.doesNotMatch(prompt, /artifact_put|curl -|sh -c/)
  assert.match(script, /system artifact put "\$dir\/report\.md" --media-type text\/markdown/)
})

test('the runbook names the allowlist, the script and the real run to do once', () => {
  for (const s of ['--allowedTools', 'system-night-session.sh', 'mcp__system__work_submit'])
    assert.ok(section.includes(s) || runbook.includes(s), s)
})
