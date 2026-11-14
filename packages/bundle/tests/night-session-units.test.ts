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
  assert.match(script, /exec claude -p "\$\(cat "\$repo\/tools\/night-session\.md"\)" --allowedTools "\$@"/)
})

test('the allowlist holds exactly the MCP tools the prompt names, and the wait', () => {
  assert.deepEqual(mcpAllowed, [...new Set(prompt.match(/mcp__system__\w+/g))].sort())
  assert.ok(allowed.includes('Bash(system work wait:*)'))
})

test('nothing in the allowlist approves, denies, cancels, retries or releases, or writes files or runs a shell', () => {
  for (const rule of allowed) {
    assert.doesNotMatch(rule, /approv|deny|decide|cancel|retry|release|update|credentials|login|work_run|replay/, rule)
    assert.doesNotMatch(rule, /^(Write|Edit|Bash\((bash|git|rm|cat)\b)/, rule)
    if (/^Bash\(sh\b/.test(rule)) assert.match(rule, /^Bash\(sh -c "\$SYSTEM_NIGHT_NOTIFY_COMMAND" -- \*\)$/, 'a shell only for the configured notifier')
  }
  assert.ok(!allowed.includes('Bash'), 'no bare Bash')
})

test('the notifier rules exist only under their variable and match the prompt\'s own notifier lines', () => {
  const notifier = allowed.filter((r) => /curl|sh -c/.test(r))
  assert.equal(notifier.length, 2)
  for (const rule of notifier) {
    const variable = /SYSTEM_NIGHT_NOTIFY_\w+/.exec(rule)![0]
    const quoted = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    assert.match(script, new RegExp(`if \\[ -n "\\$\\{${variable}:-\\}" \\]; then\\n\\s*set -- "\\$@" '${quoted}'\\nfi`), `${rule} is added only when ${variable} is set`)
    const body = rule.slice('Bash('.length, -1)
    const pattern = new RegExp(`^${body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
    const line = prompt.split('\n').map((l) => l.replace(/^.*?&& /, '')).find((l) => pattern.test(l.trim()))
    assert.ok(line, `no prompt line is allowed by ${rule}`)
  }
  for (const guard of ['SYSTEM_NIGHT_NOTIFY_URL', 'SYSTEM_NIGHT_NOTIFY_COMMAND'])
    assert.ok(allowed.includes(`Bash([ -n "\${${guard}:-}" ])`), `${guard} guard`)
})

test('the runbook names the allowlist, the script and the real run to do once', () => {
  for (const s of ['--allowedTools', 'system-night-session.sh', 'mcp__system__work_submit'])
    assert.ok(section.includes(s) || runbook.includes(s), s)
})
