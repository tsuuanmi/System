import assert from 'node:assert/strict'
import { test } from 'node:test'
import { update } from '../../../bin/update.mjs'

const SHA = 'b'.repeat(40)
const OLD = 'a'.repeat(40)

/** A fake machine: a filesystem of paths and links, the commands run and their answers, the Host's probes. */
function machine(options: { current?: string; checks?: number; build?: number; hostUp?: boolean; releases?: string[] } = {}) {
  const ran: string[] = []
  const links = new Map<string, string>(options.current ? [['/i/current', `releases/${options.current}`]] : [])
  const dirs = new Set<string>(['/i/repo', ...(options.releases ?? (options.current ? [options.current] : [])).map((r) => `/i/releases/${r}`)])
  const log: string[] = []
  let probes = 0
  let clock = 0
  const deps = {
    install: '/i',
    cli: '/cli/bin/system',
    origin: 'git@example:o/System.git',
    waitMs: 60_000,
    log: (line: string) => { log.push(line) },
    exists: (path: string) => dirs.has(path) || links.has(path),
    readlink: (path: string) => links.get(path),
    switchLink: (path: string, target: string) => { links.set(path, target) },
    releases: () => [...dirs].filter((d) => d.startsWith('/i/releases/')).map((d) => d.slice('/i/releases/'.length)),
    now: () => clock,
    sleep: async (ms: number) => { clock += ms },
    probe: async () => { probes++; return options.hostUp ?? true },
    run: async (command: string, args: string[], cwd?: string) => {
      const line = [command, ...args].join(' ') + (cwd ? ` @${cwd}` : '')
      ran.push(line)
      if (args.includes('rev-parse')) return { status: 0, stdout: `${SHA}\n` }
      if (args.includes('worktree') && args.includes('remove')) { dirs.delete(args.at(-1)!); return { status: 0, stdout: '' } }
      if (args.includes('worktree')) { dirs.add(`/i/releases/${SHA}`); return { status: 0, stdout: '' } }
      if (args[0] === 'task') return { status: 0, stdout: 'base sha256:base\nsha256:task\n' }
      if (args[0] === 'work') return { status: options.checks ?? 0, stdout: 'work:checked\n' }
      if (command === 'corepack' && args.includes('build')) return { status: options.build ?? 0, stdout: '' }
      return { status: 0, stdout: '' }
    },
  }
  return { deps, ran, links, dirs, log, probes: () => probes }
}

test('a new commit of main is built, checked by a System Work on that commit, then made current; the Host is asked until it runs it', async () => {
  const m = machine({ current: OLD })
  assert.equal(await update(m.deps), 0)
  const order = m.ran.map((line) => line.split(' ').slice(0, 4).join(' '))
  assert.deepEqual(order, [
    'git -C /i/repo fetch',
    'git -C /i/repo rev-parse',
    `git -C /i/repo worktree`,
    'corepack pnpm install --frozen-lockfile',
    'corepack pnpm build @/i/releases/' + SHA,
    '/cli/bin/system task new --text',
    '/cli/bin/system work submit --workflow',
    '/cli/bin/system work show work:checked',
  ])
  assert.ok(m.ran.some((line) => line.includes(`--repo /i/repo --ref ${SHA}`)))
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
  m.dirs.delete('/i/repo')
  assert.equal(await update(m.deps), 0)
  assert.equal(m.ran[0], 'git clone --no-checkout git@example:o/System.git /i/repo')
})

test('after a switch, only the current release and the one before stay', async () => {
  const m = machine({ current: OLD, releases: [OLD, 'c'.repeat(40), 'd'.repeat(40)] })
  assert.equal(await update(m.deps), 0)
  assert.deepEqual(m.deps.releases().sort(), [OLD, SHA].sort())
  assert.ok(m.ran.some((line) => line.startsWith(`git -C /i/repo worktree remove --force /i/releases/${'c'.repeat(40)}`)))
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
