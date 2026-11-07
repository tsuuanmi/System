import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MIN_NODE, UPGRADE_EXIT, nodeChoice, serviceMode, supervise, unitPath, unitText } from '../../../bin/service.mjs'

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

test('the unit restarts on exit 75, the status of a Host that stopped to upgrade', () => {
  const text = unitText({ node: '/n', entry: '/e', home: '/h', path: '/p' })
  assert.match(text, /^RestartForceExitStatus=75$/m)
  assert.equal(UPGRADE_EXIT, 75)
})

test('the supervisor runs the Host again after exit 75 and after nothing else', async () => {
  const run = (codes: number[], stopped = () => false) => {
    const log: string[] = []
    let runs = 0
    return supervise({ run: async () => codes[runs++]!, stopped, log: (line: string) => log.push(line) }).then((code: number) => ({ code, runs, log }))
  }
  assert.deepEqual((await run([75, 75, 0])).code, 0)
  assert.equal((await run([75, 75, 0])).runs, 3)
  const failed = await run([75, 1, 0])
  assert.deepEqual([failed.code, failed.runs], [1, 2])
  assert.match(failed.log.join('\n'), /restarting: the Host stopped to upgrade/)
  const clean = await run([0, 75])
  assert.deepEqual([clean.code, clean.runs], [0, 1])
  // A signal to the supervisor is a stop: a Host that exits 75 anyway is not restarted.
  const stopped = await run([75, 0], () => true)
  assert.deepEqual([stopped.code, stopped.runs], [75, 1])
})
