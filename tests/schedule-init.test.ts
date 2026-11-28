/**
 * Item sch-4: `system init` under a temporary HOME writes the user units of each Schedule file, enables none,
 * rewrites them when the file changed and removes those of a file that is gone. systemctl and loginctl are stubs.
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { systemCli } from '../test-support/cli.ts'

const root = mkdtempSync('/tmp/sched-init-')
const home = join(root, '.dsh')
const stubs = join(root, 'stubs')
const calls = join(root, 'calls.log')
mkdirSync(stubs, { recursive: true })
for (const name of ['systemctl', 'loginctl', 'systemd-analyze']) {
  writeFileSync(join(stubs, name), `#!/bin/sh\necho "${name} $*" >> ${calls}\nexit 0\n`)
  chmodSync(join(stubs, name), 0o755)
}
const cli = systemCli('sched-init', { SYSTEM_OPERATOR_ID: 'tester', SYSTEM_CALLER: 'human', HOME: root, PATH: `${stubs}:${process.env.PATH}` }, home)
after(() => { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }) })

const units = join(root, '.config', 'systemd', 'user')
const schedules = join(root, '.system', 'schedules')
const names = () => readdirSync(units).filter((n) => n.startsWith('system-schedule-')).sort()

test('init writes the units of each Schedule file, enables none, rewrites a changed file and removes a gone one', { timeout: 300_000 }, () => {
  mkdirSync(schedules, { recursive: true })
  writeFileSync(join(schedules, 'night.yaml'), 'kind: items\nrepositories: [/w/System, /w/DNA]\nat: ["*-*-* 01:00", "*-*-* 02..07:00"]\n')
  writeFileSync(join(schedules, 'other.yaml'), 'kind: items\nrepositories: [/w/X]\nat: daily\n')
  const first = cli.run(['init'])
  assert.equal(first.status, 0, first.stderr)
  assert.deepEqual(names(), ['system-schedule-night.service', 'system-schedule-night.timer', 'system-schedule-other.service', 'system-schedule-other.timer'])
  const service = readFileSync(join(units, 'system-schedule-night.service'), 'utf8')
  assert.match(service, new RegExp(`items carry --schedule ${join(schedules, 'night.yaml').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
  assert.match(service, /^ExecStartPre=/m)
  const timer = readFileSync(join(units, 'system-schedule-night.timer'), 'utf8')
  assert.deepEqual(timer.match(/^OnCalendar=.*$/gm), ['OnCalendar=*-*-* 01:00', 'OnCalendar=*-*-* 02..07:00'])
  assert.match(timer, /^Persistent=false$/m)
  assert.match(first.stdout, /system-schedule-night\.timer/)
  const log = readFileSync(calls, 'utf8')
  assert.doesNotMatch(log, /systemctl .*(enable|start)/)

  // The file changes: the timer follows. The other file is gone: its units go.
  writeFileSync(join(schedules, 'night.yaml'), 'kind: items\nrepositories: [/w/System]\nat: "*-*-* 03:00"\n')
  rmSync(join(schedules, 'other.yaml'))
  const second = cli.run(['init'])
  assert.equal(second.status, 0, second.stderr)
  assert.deepEqual(names(), ['system-schedule-night.service', 'system-schedule-night.timer'])
  assert.deepEqual(readFileSync(join(units, 'system-schedule-night.timer'), 'utf8').match(/^OnCalendar=.*$/gm), ['OnCalendar=*-*-* 03:00'])
})

test('a Schedule file that does not parse (or is kind: work) writes no unit, keeps the existing ones and fails init', { timeout: 300_000 }, () => {
  writeFileSync(join(schedules, 'night.yaml'), 'kind: work\nat: daily\n')
  const before = readFileSync(join(units, 'system-schedule-night.timer'), 'utf8')
  const ran = cli.run(['init'])
  assert.equal(ran.status, 1)
  assert.match(ran.stderr, /night\.yaml: kind: work is not built yet/)
  assert.equal(readFileSync(join(units, 'system-schedule-night.timer'), 'utf8'), before)
  rmSync(join(schedules, 'night.yaml'))
  assert.equal(cli.run(['init']).status, 0)
  assert.equal(existsSync(join(units, 'system-schedule-night.timer')), false)
})
