import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIN_NODE, UPGRADE_EXIT, hostCommand, installRoot, nodeChoice, scheduleServiceText, scheduleTimerText, scheduleUnits, serviceMode, supervise, syncScheduleUnits, unitOverlays, unitPath, unitText } from '../../../bin/service.mjs'

test('a Node that is new enough runs the command itself', () => {
  assert.deepEqual(nodeChoice('24.9.0', ['v24.21.0']), { use: 'current' })
  assert.deepEqual(nodeChoice('24.21.0', []), { use: 'current' })
  assert.deepEqual(nodeChoice('26.0.1', []), { use: 'current' })
  assert.equal(MIN_NODE, '24.9.0')
})

test('an older Node hands over to the newest installed Node 24 that is at least 24.9', () => {
  const installed = ['v22.20.0', 'v24.8.0', 'v24.9.0', 'v24.10.1', 'v24.9.5', 'v25.1.0', 'not-a-version']
  assert.deepEqual(nodeChoice('22.20.0', installed), { use: 'other', version: 'v24.10.1' })
  assert.deepEqual(nodeChoice('24.8.1', installed), { use: 'other', version: 'v24.10.1' })
})

test('versions compare as numbers, not text', () => {
  assert.deepEqual(nodeChoice('20.0.0', ['v24.9.0', 'v24.10.0', 'v24.100.0', 'v24.99.0']), { use: 'other', version: 'v24.100.0' })
})

test('with no Node 24.9 or newer installed, the choice is none', () => {
  assert.deepEqual(nodeChoice('22.20.0', ['v22.20.0', 'v24.8.9', 'v25.0.0']), { use: 'none' })
  assert.deepEqual(nodeChoice('22.20.0', []), { use: 'none' })
})

test('the unit runs this Node on `bin/system host`, with the home and the PATH of init, and restarts on failure', () => {
  const text = unitText({ node: '/opt/node/bin/node', entry: '/src/system/bin/system', home: '/home/tan/.dsh', path: '/usr/bin:/home/tan/.nvm/bin' })
  assert.match(text, /^\[Unit\]\nDescription=.*\n/)
  assert.match(text, /^ExecStart=\/opt\/node\/bin\/node \/src\/system\/bin\/system host$/m)
  assert.match(text, /^Environment=DSH_HOME=\/home\/tan\/\.dsh$/m)
  assert.match(text, /^Environment=PATH=\/usr\/bin:\/home\/tan\/\.nvm\/bin$/m)
  assert.match(text, /^Restart=on-failure$/m)
  assert.match(text, /^WantedBy=default\.target$/m)
  assert.doesNotMatch(text, /Socket|\.socket/i)
})

test('a path with a space or a percent sign is quoted for systemd', () => {
  const text = unitText({ node: '/opt/my node/node', entry: '/src/100%/bin/system', home: '/h/a b', path: '/x y:/z' })
  assert.match(text, /^ExecStart="\/opt\/my node\/node" \/src\/100%%\/bin\/system host$/m)
  assert.match(text, /^Environment="DSH_HOME=\/h\/a b"$/m)
  assert.match(text, /^Environment="PATH=\/x y:\/z"$/m)
})

test('the unit file is under the user systemd config directory', () => {
  assert.equal(unitPath('/home/tan'), '/home/tan/.config/systemd/user/system.service')
})

test('only the default home gets the unit; --no-service and SYSTEM_NO_SERVICE=1 skip it; another home runs in the foreground', () => {
  const base = { homedir: '/home/tan', platform: 'linux' as const, args: [], env: {} }
  assert.equal(serviceMode({ ...base, home: '/home/tan/.dsh' }), 'install')
  assert.equal(serviceMode({ ...base, home: '/home/tan/.dsh/' }), 'install')
  assert.equal(serviceMode({ ...base, home: '/home/tan/.dsh', args: ['--no-service'] }), 'skip')
  assert.equal(serviceMode({ ...base, home: '/home/tan/.dsh', env: { SYSTEM_NO_SERVICE: '1' } }), 'skip')
  assert.equal(serviceMode({ ...base, home: '/home/tan/.dsh', env: { SYSTEM_NO_SERVICE: '0' } }), 'install')
  assert.equal(serviceMode({ ...base, home: '/tmp/other' }), 'foreground')
  assert.equal(serviceMode({ ...base, home: '/tmp/other', args: ['--no-service'] }), 'skip')
  assert.equal(serviceMode({ ...base, home: '/home/tan/.dsh', platform: 'darwin' }), 'skip')
})

test('the unit restarts on exit 75, the status of a Host that stopped to upgrade, and retries a failed start for minutes, not 100 ms', () => {
  const text = unitText({ node: '/n', entry: '/e', home: '/h', path: '/p' })
  assert.match(text, /^RestartForceExitStatus=75$/m)
  assert.match(text, /^RestartSec=5$/m)
  // StartLimit* belong to [Unit]: at most 10 starts in 5 minutes, not systemd's default of 5 in 10 s.
  assert.match(text, /\[Unit\][^[]*^StartLimitIntervalSec=300$/m)
  assert.match(text, /\[Unit\][^[]*^StartLimitBurst=10$/m)
  assert.equal(UPGRADE_EXIT, 75)
})

test('the supervisor runs the Host again after exit 75; a Host that fails to come back is tried again, with backoff, three times', async () => {
  const run = (codes: number[], stopped = () => false) => {
    const log: string[] = []
    const waited: number[] = []
    let runs = 0
    return supervise({ run: async () => codes[runs++]!, stopped, log: (line: string) => log.push(line), wait: async (ms: number) => { waited.push(ms) } })
      .then((code: number) => ({ code, runs, log, waited }))
  }
  assert.deepEqual((await run([75, 75, 0])).code, 0)
  assert.equal((await run([75, 75, 0])).runs, 3)
  // The new code may be half built when the Host stops for it: its first starts can fail.
  const recovered = await run([75, 1, 1, 0])
  assert.deepEqual([recovered.code, recovered.runs, recovered.waited], [0, 4, [2000, 4000]])
  assert.match(recovered.log.join('\n'), /restarting: the Host stopped to upgrade/)
  assert.match(recovered.log.join('\n'), /the Host exited 1 after the upgrade; trying again in 2 s \(1 of 3\)/)
  const failed = await run([75, 1, 1, 1, 1, 0])
  assert.deepEqual([failed.code, failed.runs, failed.waited], [1, 5, [2000, 4000, 8000]])
  assert.match(failed.log.at(-1)!, /gave up/)
  // A Host that fails without an upgrade before it is not tried again.
  assert.deepEqual(await run([1, 0]).then((r) => [r.code, r.runs]), [1, 1])
  // A later upgrade starts the count again.
  assert.deepEqual(await run([75, 1, 75, 1, 1, 0]).then((r) => [r.code, r.runs]), [0, 6])
  const clean = await run([0, 75])
  assert.deepEqual([clean.code, clean.runs], [0, 1])
  // A signal to the supervisor is a stop: a Host that exits 75 anyway is not restarted.
  const stopped = await run([75, 0], () => true)
  assert.deepEqual([stopped.code, stopped.runs], [75, 1])
})

test('`host` is found after the global options of dsh, and a value of one is not a command', () => {
  assert.equal(hostCommand(['host', '--supervise']), true)
  assert.equal(hostCommand(['--patch', 'x.yml', 'host', '--supervise']), true)
  assert.equal(hostCommand(['--patch=x.yml', '--profile', 'system', 'host']), true)
  assert.equal(hostCommand(['--dump-config', 'host']), true)
  assert.equal(hostCommand(['--patch', 'host']), false)
  assert.equal(hostCommand(['--patch', 'x.yml', 'doctor']), false)
  assert.equal(hostCommand([]), false)
})

test('a release under <install>/releases runs as the install, through its current link; a checkout runs as itself', () => {
  const exists = (path: string) => path === '/home/tan/.system/current'
  assert.equal(installRoot('/home/tan/.system/releases/0123abc', exists), '/home/tan/.system/current')
  assert.equal(installRoot('/home/tan/workspaces/System', exists), '/home/tan/workspaces/System')
  assert.equal(installRoot('/other/releases/0123abc', exists), '/other/releases/0123abc')
})

test('with a profile file, the unit runs the Host with it as a patch', () => {
  const text = unitText({ node: '/n', entry: '/home/tan/.system/current/bin/system', home: '/home/tan/.dsh', path: '/usr/bin', patch: '/home/tan/.system/profile.yml' })
  assert.match(text, /^ExecStart=\/n \/home\/tan\/\.system\/current\/bin\/system --patch \/home\/tan\/\.system\/profile\.yml host$/m)
})

test('a Schedule service waits for doctor, runs the install\'s `items carry --schedule`, and has no start timeout', () => {
  const text = scheduleServiceText({ name: 'daily', node: '/opt/node/bin/node', entry: '/home/tan/.system/current/bin/system', home: '/home/tan/.dsh', path: '/usr/bin', file: '/home/tan/.system/schedules/daily.yaml' })
  assert.match(text, /^Description=.*daily/m)
  assert.match(text, /^Type=oneshot$/m)
  assert.match(text, /^ExecStartPre=\/bin\/sh -c ".*" sh \/opt\/node\/bin\/node \/home\/tan\/\.system\/current\/bin\/system doctor$/m)
  assert.match(text, /^ExecStart=\/opt\/node\/bin\/node \/home\/tan\/\.system\/current\/bin\/system items carry --schedule \/home\/tan\/\.system\/schedules\/daily\.yaml$/m)
  assert.match(text, /^Environment=DSH_HOME=\/home\/tan\/\.dsh$/m)
  assert.match(text, /^Environment=PATH=\/usr\/bin$/m)
  assert.doesNotMatch(text, /TimeoutStartSec/)
  assert.doesNotMatch(text, /\[Install\]/)
})

test('a Schedule timer has one OnCalendar for each `at`, Persistent=false, and is wanted by timers.target', () => {
  const text = scheduleTimerText({ name: 'daily', at: ['*-*-* 01:00', '*-*-* 02..07:00'] })
  assert.deepEqual(text.match(/^OnCalendar=.*$/gm), ['OnCalendar=*-*-* 01:00', 'OnCalendar=*-*-* 02..07:00'])
  assert.match(text, /^Persistent=false$/m)
  assert.match(text, /^WantedBy=timers\.target$/m)
})

test('scheduleUnits names a pair of units for each Schedule', () => {
  const units = scheduleUnits({ node: 'n', entry: 'e', home: 'h', path: 'p', schedules: [{ name: 'a', file: '/s/a.yaml', at: ['daily'] }] })
  assert.deepEqual([...units.keys()], ['system-schedule-a.service', 'system-schedule-a.timer'])
})

test('syncing Schedule units writes new ones, rewrites changed ones, leaves same ones and removes those of a gone file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'units-'))
  try {
    writeFileSync(join(dir, 'system.service'), 'host')
    writeFileSync(join(dir, 'system-custom.timer'), 'unrelated timer')
    writeFileSync(join(dir, 'system-schedule-gone.service'), 'x')
    writeFileSync(join(dir, 'system-schedule-gone.timer'), 'x')
    writeFileSync(join(dir, 'system-schedule-kept.timer'), 'x')
    writeFileSync(join(dir, 'system-schedule-same.service'), 'same')
    const wanted = new Map([['system-schedule-same.service', 'same'], ['system-schedule-new.service', 'n']])
    const changed = syncScheduleUnits(dir, wanted, ['kept'])
    assert.deepEqual(changed, { written: ['system-schedule-new.service'], removed: ['system-schedule-gone.service', 'system-schedule-gone.timer'] })
    assert.deepEqual(readdirSync(dir).sort(), ['system-custom.timer', 'system-schedule-kept.timer', 'system-schedule-new.service', 'system-schedule-same.service', 'system.service'])
    writeFileSync(join(dir, 'system-schedule-new.service'), 'edited')
    assert.deepEqual(syncScheduleUnits(dir, wanted, []).written, ['system-schedule-new.service'])
    assert.equal(readFileSync(join(dir, 'system-schedule-new.service'), 'utf8'), 'n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sch-5: a Schedule with checkAt has a check service and timer; one without has none', () => {
  const base = { node: '/n', entry: '/e/bin/system', home: '/h', path: '/p' }
  const units = scheduleUnits({ ...base, schedules: [{ name: 'daily', file: '/s/daily.yaml', at: ['daily'], checkAt: '*-*-* 00:30' }, { name: 'plain', file: '/s/plain.yaml', at: ['daily'] }] })
  assert.deepEqual([...units.keys()].sort(), ['system-schedule-daily-check.service', 'system-schedule-daily-check.timer', 'system-schedule-daily.service', 'system-schedule-daily.timer', 'system-schedule-plain.service', 'system-schedule-plain.timer'])
  const service = units.get('system-schedule-daily-check.service')!
  assert.match(service, /^ExecStart=\/n \/e\/bin\/system items carry --schedule \/s\/daily\.yaml --check$/m)
  assert.doesNotMatch(service, /ExecStartPre/)
  assert.deepEqual(units.get('system-schedule-daily-check.timer')!.match(/^(OnCalendar|Persistent)=.*$/gm), ['OnCalendar=*-*-* 00:30', 'Persistent=false'])
})

test('safeup-1: unitOverlays reads --patch overlay paths from ExecStart, unquoting and unescaping systemd words', () => {
  const plain = unitText({ node: '/n', entry: '/e', home: '/h', path: '/p', patch: '/home/tan/.system/profile.yml' })
  assert.deepEqual(unitOverlays(plain), ['/home/tan/.system/profile.yml'])
  const escaped = unitText({ node: '/n', entry: '/e', home: '/h', path: '/p', patch: '/home/tan/my dir/100%$profile.yml' })
  assert.deepEqual(unitOverlays(escaped), ['/home/tan/my dir/100%$profile.yml'])
  const multi = '[Service]\nExecStart=/n /e --patch /a.yml --patch=/b.yml host\n'
  assert.deepEqual(unitOverlays(multi), ['/a.yml', '/b.yml'])
  const none = unitText({ node: '/n', entry: '/e', home: '/h', path: '/p' })
  assert.deepEqual(unitOverlays(none), [])
})
