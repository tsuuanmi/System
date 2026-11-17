// Driver of tests/pending-install-check.test.ts: the real `update()` of bin/update.mjs with the real client, Host, probe and link switch,
// except the steps that need the network or a build: fetch, worktree add, `pnpm install/build` and the release check Work (code-checks.yaml)
// are answered here. Args: <install> <repo> <new commit> <old release's bin/system> <wait ms>.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { update } from '../bin/update.mjs'

const [install, repo, commit, cli, wait] = process.argv.slice(2)
const home = process.env.DSH_HOME
const capture = (command, args, cwd) => new Promise((done) => {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], env: process.env })
  let stdout = ''
  child.stdout.on('data', (data) => { stdout += data })
  child.on('exit', (code) => done({ status: code ?? 1, stdout }))
})
const answer = { status: 0, stdout: '' }
process.exitCode = await update({
  install, cli, origin: repo, waitMs: Number(wait),
  run: async (command, args, cwd) => {
    if (command === 'git' && args.includes('fetch')) return answer
    if (command === 'git' && args.includes('rev-parse')) return { status: 0, stdout: `${commit}\n` }
    if (command === 'git' && args.includes('worktree')) return answer
    if (/corepack$/.test(command)) return answer
    if (args[0] === 'work' && args.some((a) => a.endsWith('code-checks.yaml'))) return { status: 0, stdout: 'work:release-check\n' }
    if (args[0] === 'work' && args[1] === 'show' && args[2] === 'work:release-check') return answer
    return capture(command, args, cwd)
  },
  write: (path, text) => writeFileSync(path, text),
  read: (path) => { try { return readFileSync(path, 'utf8') } catch { return undefined } },
  remove: (path) => rmSync(path, { force: true }),
  exists: existsSync,
  readlink: (link) => { try { return readlinkSync(link) } catch { return undefined } },
  switchLink: (link, target) => { rmSync(`${link}.new`, { force: true }); symlinkSync(target, `${link}.new`); renameSync(`${link}.new`, link) },
  releases: () => readdirSync(join(install, 'releases')),
  probe: async (release) => {
    const { VERSION, connectHello } = await import(pathToFileURL(join(release, 'packages', 'host', 'lib', 'index.js')).href)
    const { socketPath } = await import(pathToFileURL(join(release, 'packages', 'host', 'lib', 'process.js')).href)
    try {
      (await connectHello(socketPath(home), { version: VERSION, caller: { type: 'agent', operatorId: userInfo().username } })).close()
      return true
    } catch { return false }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  log: (line) => process.stderr.write(`system update: ${line}\n`),
})
