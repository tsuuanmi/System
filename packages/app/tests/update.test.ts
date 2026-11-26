import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { PENDING, finishPending, update } from '../../../bin/update.mjs'

const SHA = 'b'.repeat(40)
const OLD = 'a'.repeat(40)

/** A fake machine: a filesystem of paths and links, the commands run and their answers, the Host's probes. */
function machine(options: { current?: string; checks?: number; build?: number; hostUp?: boolean; releases?: string[]; afterInstall?: boolean; installCheck?: number; skew?: boolean } = {}) {
  const ran: string[] = []
  const links = new Map<string, string>(options.current ? [['/i/current', `releases/${options.current}`]] : [])
  const dirs = new Set<string>(['/i/release', ...(options.releases ?? (options.current ? [options.current] : [])).map((r) => `/i/releases/${r}`)])
  const log: string[] = []
  const written = new Map<string, string>()
  let probes = 0
  let clock = 0
  const deps = {
    install: '/i',
    cli: '/cli/bin/system',
    origin: 'git@example:o/System.git',
    waitMs: 60_000,
    log: (line: string) => { log.push(line) },
    write: (path: string, text: string) => { written.set(path, text) },
    read: (path: string) => written.get(path),
    remove: (path: string) => { written.delete(path) },
    exists: (path: string) => dirs.has(path) || links.has(path),
    readlink: (path: string) => links.get(path),
    switchLink: (path: string, target: string) => { links.set(path, target) },
    releases: () => [...dirs].filter((d) => d.startsWith('/i/releases/')).map((d) => d.slice('/i/releases/'.length)),
    now: () => clock,
    sleep: async (ms: number) => { clock += ms },
    probe: async () => { probes++; return options.hostUp ?? true },
    run: async (command: string, args: string[], cwd?: string) => {
      // corepack is run by the path beside this Node (Item ns-2); the log keeps its name.
      const line = [command === join(dirname(process.execPath), 'corepack') ? 'corepack' : command, ...args].join(' ') + (cwd ? ` @${cwd}` : '')
      ran.push(line)
      if (args.includes('rev-parse')) return { status: 0, stdout: `${SHA}\n` }
      if (args.includes('worktree') && args.includes('remove')) { dirs.delete(args.at(-1)!); return { status: 0, stdout: '' } }
      if (args.includes('worktree')) { dirs.add(`/i/releases/${SHA}`); return { status: 0, stdout: '' } }
      if (args[0] === 'task') return { status: 0, stdout: 'sha256:task\n' }
      if (args.includes('show') && args.some((a) => a.endsWith(':checks.yaml') || a.includes('.system/checks.yaml'))) {
        return options.afterInstall ? { status: 0, stdout: 'checks:\n  - name: x\n    run: "true"\nafterInstall:\n  - name: answers\n    run: system ping\n' } : { status: 0, stdout: 'checks:\n  - name: x\n    run: "true"\n' }
      }
      // Version skew: once the Host runs the new release, it refuses the old release's client (`cli`).
      if (options.skew && links.get('/i/current') === `releases/${SHA}` && command === '/cli/bin/system' && args[0] === 'work') return { status: 1, stdout: 'the client is older: restart the client\n' }
      // The first `node` on PATH is an old Node (below MIN_NODE) that fails; only process.execPath works.
      if (command === 'node') return { status: 1, stdout: 'node: too old\n' }
      if (command === process.execPath && args[0] === `/i/releases/${SHA}/bin/system`) { command = '/cli/bin/system'; args = args.slice(1) }
      if (args[0] === 'work' && args.some((a) => a.endsWith('install-check.yaml'))) return { status: options.installCheck ?? 0, stdout: 'work:installed\n' }
      if (args[0] === 'work' && args[1] === 'show' && args[2] === 'work:installed') return { status: 0, stdout: '{"reason": "failed: answers: no such command"}' }
      if (args[0] === 'work') return { status: options.checks ?? 0, stdout: 'work:checked\n' }
      if (command === join(dirname(process.execPath), 'corepack') && args.includes('build')) return { status: options.build ?? 0, stdout: '' }
      return { status: 0, stdout: '' }
    },
  }
  return { deps, ran, links, dirs, log, written, probes: () => probes }
}

test('a new commit of main is built, checked by a System Work on that commit, then made current; the Host is asked until it runs it', async () => {
  const m = machine({ current: OLD })
  assert.equal(await update(m.deps), 0)
  const order = m.ran.map((line) => line.split(' ').slice(0, 4).join(' '))
  assert.deepEqual(order, [
    'git -C /i/release fetch',
    'git -C /i/release rev-parse',
    `git -C /i/release worktree`,
    'corepack pnpm install --frozen-lockfile',
    'corepack pnpm build @/i/releases/' + SHA,
    '/cli/bin/system task new --text',
    '/cli/bin/system work submit --workflow',
    '/cli/bin/system work show work:checked',
    'git -C /i/release show',
  ])
  assert.ok(m.ran.some((line) => line.includes(`--repo /i/release --ref ${SHA}`)))
  assert.ok(m.ran.some((line) => line.includes(`--workflow /i/releases/${SHA}/workflows/code-checks.yaml --input sha256:task`)))
  assert.equal(m.links.get('/i/current'), `releases/${SHA}`)
  assert.ok(m.probes() >= 1)
  assert.ok(m.log.some((line) => line.includes('work:checked')))
})

test('when the checks fail, current stays where it was and the Host is not asked', async () => {
  const m = machine({ current: OLD, checks: 1 })
  assert.equal(await update(m.deps), 1)
  assert.equal(m.links.get('/i/current'), `releases/${OLD}`)
  assert.equal(m.probes(), 0)
  assert.ok(m.log.some((line) => line.includes('work:checked') && line.includes('failed')))
})

test('when the build fails, nothing is checked and current stays', async () => {
  const m = machine({ current: OLD, build: 2 })
  assert.equal(await update(m.deps), 1)
  assert.ok(!m.ran.some((line) => line.includes('task new')))
  assert.equal(m.links.get('/i/current'), `releases/${OLD}`)
})

test('when the Host does not come up on the new code in time, current is switched back', async () => {
  const m = machine({ current: OLD, hostUp: false })
  assert.equal(await update(m.deps), 1)
  assert.equal(m.links.get('/i/current'), `releases/${OLD}`)
  assert.ok(m.log.some((line) => /switched back/.test(line)))
})

test('the commit already current is nothing to do', async () => {
  const m = machine({ current: SHA })
  assert.equal(await update(m.deps), 0)
  assert.ok(!m.ran.some((line) => line.includes('corepack') || line.includes('task new')))
})

test('the first install makes current and says how to start the Host, without asking one', async () => {
  const m = machine()
  assert.equal(await update(m.deps), 0)
  assert.equal(m.links.get('/i/current'), `releases/${SHA}`)
  assert.equal(m.probes(), 0)
  assert.ok(m.log.some((line) => line.includes('system init')))
})

test('a missing repository is cloned from the origin first', async () => {
  const m = machine({ current: OLD })
  m.dirs.delete('/i/release')
  assert.equal(await update(m.deps), 0)
  assert.equal(m.ran[0], 'git clone --no-checkout git@example:o/System.git /i/release')
})

test('after a switch, only the current release and the one before stay', async () => {
  const m = machine({ current: OLD, releases: [OLD, 'c'.repeat(40), 'd'.repeat(40)] })
  assert.equal(await update(m.deps), 0)
  assert.deepEqual(m.deps.releases().sort(), [OLD, SHA].sort())
  assert.ok(m.ran.some((line) => line.startsWith(`git -C /i/release worktree remove --force /i/releases/${'c'.repeat(40)}`)))
})

test('with a current release, the new commit is checked as a change from it, and the log says what it was compared with and what was skipped', async () => {
  const m = machine({ current: OLD })
  const run = m.deps.run
  m.deps.run = async (command: string, args: string[], cwd?: string) => {
    if (args[0] === 'work' && args[1] === 'show') { m.ran.push(args.join(' ')); return { status: 0, stdout: '{"reason": "all 4 check(s) run passed on x; run: docs 1.0 s; skipped: web, smoke"}' } }
    return run(command, args, cwd)
  }
  assert.equal(await update(m.deps), 0)
  assert.ok(m.ran.some((line) => line.includes(`task new --text`) && line.includes(`--ref ${SHA} --against ${OLD}`)))
  assert.ok(m.log.some((line) => line.includes('passed') && line.includes(`compared with ${OLD.slice(0, 12)}; skipped: web, smoke`)))
})

test('the first install checks the whole commit: no --against', async () => {
  const m = machine()
  assert.equal(await update(m.deps), 0)
  assert.ok(m.ran.some((line) => line.includes('task new') && !line.includes('--against')))
  assert.ok(m.log.some((line) => line.includes('whole commit, none skipped')))
})

test('without afterInstall in the release checks file, nothing more is run or written', async () => {
  const m = machine({ current: OLD })
  assert.equal(await update(m.deps), 0)
  assert.equal(m.written.size, 0)
  assert.ok(!m.ran.some((line) => line.includes('install-check')))
})

test('a passing afterInstall check leaves the new release current, with its Work named', async () => {
  const m = machine({ current: OLD, afterInstall: true })
  assert.equal(await update(m.deps), 0)
  assert.equal(m.links.get('/i/current'), `releases/${SHA}`)
  assert.ok(m.ran.some((line) => line.includes('work submit --workflow /i/install-check.yaml --input sha256:task')))
  assert.match(m.written.get('/i/install-check.yaml') ?? '', /capability: release\.install-check[\s\S]*criteria: install-check-v1/)
  assert.ok(m.log.some((line) => line.includes('work:installed') && line.includes('passed')))
  assert.deepEqual(m.deps.releases().sort(), [OLD, SHA].sort())
})

test('a failing afterInstall check switches back to the release before, names the failed check and its Work', async () => {
  const m = machine({ current: OLD, afterInstall: true, installCheck: 1 })
  assert.equal(await update(m.deps), 1)
  assert.equal(m.links.get('/i/current'), `releases/${OLD}`)
  assert.ok(m.log.some((line) => line.includes('work:installed') && line.includes('failed: answers') && line.includes('switched back')))
  assert.ok(m.dirs.has(`/i/releases/${OLD}`))
})

test('the afterInstall Work is submitted with the new release\'s client, which the new Host accepts, and the release stays', async () => {
  const m = machine({ current: OLD, afterInstall: true, skew: true })
  assert.equal(await update(m.deps), 0)
  assert.equal(m.links.get('/i/current'), `releases/${SHA}`)
  assert.ok(m.ran.some((line) => line.startsWith(`${process.execPath} /i/releases/${SHA}/bin/system work submit --workflow /i/install-check.yaml`)))
  assert.ok(!m.ran.some((line) => line.startsWith('/cli/bin/system work submit --workflow /i/install-check.yaml')))
  assert.ok(!m.ran.some((line) => line.startsWith('node ')))
})

test('a real afterInstall failure still switches back when the new release\'s client is used', async () => {
  const m = machine({ current: OLD, afterInstall: true, skew: true, installCheck: 1 })
  assert.equal(await update(m.deps), 1)
  assert.equal(m.links.get('/i/current'), `releases/${OLD}`)
  assert.ok(m.log.some((line) => line.includes('failed: answers')))
})

test('with afterInstall checks, the switch leaves a pending record naming the commit, the release before and the task, and a passed check removes it', async () => {
  const m = machine({ current: OLD, afterInstall: true })
  let atSwitch: string | undefined
  const switchLink = m.deps.switchLink
  m.deps.switchLink = (path: string, target: string) => { atSwitch ??= m.written.get(`/i/${PENDING}`); switchLink(path, target) }
  assert.equal(await update(m.deps), 0)
  assert.deepEqual({ ...JSON.parse(atSwitch!), updatePid: undefined }, { commit: SHA, previous: `releases/${OLD}`, task: 'sha256:task', releaseCheck: 'work:checked', workflow: '/i/install-check.yaml', updatePid: undefined })
  assert.equal(m.written.has(`/i/${PENDING}`), false)
})

test('a failed install check removes the record and switches back; a Host that never comes up removes it too', async () => {
  const failed = machine({ current: OLD, afterInstall: true, installCheck: 1 })
  assert.equal(await update(failed.deps), 1)
  assert.equal(failed.links.get('/i/current'), `releases/${OLD}`)
  assert.equal(failed.written.has(`/i/${PENDING}`), false)
  const down = machine({ current: OLD, afterInstall: true, hostUp: false })
  assert.equal(await update(down.deps), 1)
  assert.equal(down.written.has(`/i/${PENDING}`), false)
})

test('without afterInstall checks, or on the first install, no record is left', async () => {
  const plain = machine({ current: OLD })
  assert.equal(await update(plain.deps), 0)
  assert.equal(plain.written.has(`/i/${PENDING}`), false)
  const first = machine({ afterInstall: true })
  assert.equal(await update(first.deps), 0)
  assert.equal(first.written.has(`/i/${PENDING}`), false)
})

test('finishPending: runs the check for a record of its own commit once the update that wrote it is gone, and a failure switches back', async () => {
  const record = (commit: string) => JSON.stringify({ commit, previous: `releases/${OLD}`, task: 'sha256:task', workflow: '/i/install-check.yaml', updatePid: 4242 })
  for (const [status, current, left] of [[0, `releases/${SHA}`, false], [1, `releases/${OLD}`, false]] as const) {
    const m = machine({ current: SHA, installCheck: status })
    m.written.set(`/i/${PENDING}`, record(SHA))
    const deps = { install: '/i', commit: SHA, alive: () => false, run: m.deps.run, read: m.deps.read, write: m.deps.write, remove: m.deps.remove, switchLink: m.deps.switchLink, log: m.deps.log }
    assert.equal(await finishPending(deps), status)
    assert.equal(m.links.get('/i/current'), current)
    assert.equal(m.written.has(`/i/${PENDING}`), left)
  }
  // A live update completes it itself; a record of another commit is not this Host's.
  for (const [commit, alive] of [[SHA, true], [OLD, false]] as const) {
    const m = machine({ current: SHA })
    m.written.set(`/i/${PENDING}`, record(commit))
    const deps = { install: '/i', commit: SHA, alive: () => alive, run: m.deps.run, read: m.deps.read, write: m.deps.write, remove: m.deps.remove, switchLink: m.deps.switchLink, log: m.deps.log }
    assert.equal(await finishPending(deps), 0)
    assert.ok(!m.ran.some((line) => line.includes('work submit')))
    assert.equal(m.written.has(`/i/${PENDING}`), true)
  }
})

test('a running release that knows the release criteria is checked on the release event; an older one with the file code-checks.yaml (ct-1)', async () => {
  const known = machine({ current: OLD })
  known.written.set(`/i/releases/${OLD}/packages/verifiers/src/checks.ts`, "export const REPO_CHECKS_RELEASE = 'repo-checks-release-v1'\n")
  assert.equal(await update(known.deps), 0)
  const submit = known.ran.find((line) => line.includes('work submit'))!
  assert.ok(submit.includes('--workflow /i/release-check.yaml --input sha256:task'), submit)
  assert.match(known.written.get('/i/release-check.yaml')!, /criteria: repo-checks-release-v1/)
  assert.match(known.written.get('/i/release-check.yaml')!, /capability: code\.required-checks/)

  const older = machine({ current: OLD })
  older.written.set(`/i/releases/${OLD}/packages/verifiers/src/checks.ts`, "export const REPO_CHECKS_V2 = 'repo-checks-v2'\n")
  assert.equal(await update(older.deps), 0)
  assert.ok(older.ran.some((line) => line.includes(`--workflow /i/releases/${SHA}/workflows/code-checks.yaml`)))
  assert.ok(!older.written.has('/i/release-check.yaml'))
})
