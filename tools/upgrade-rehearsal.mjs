#!/usr/bin/env node
// The `upgrade` check of .system/checks.yaml (Item rb-1): rehearse a release before it is merged. Escaped defects 3, 7, 8 and the
// install assumptions of fl-6 showed only on an update from the previous release, so this runs one, with temporary homes only:
//   1. the last release (`origin/main`, else `main`; `--release <ref>`) is built as the install's first release, with a Host running it;
//   2. the commit under check (the working tree of this repository on top of HEAD; `--commit <ref>` uses a commit as it is) becomes
//      `main` of a local bare `origin`, with `dev` beside it (the afterInstall checks fetch it);
//   3. THAT install's `system update` runs (its Host drains and the supervisor starts the new code, as the user unit would).
// It passes only when the update ends with `current` on the new release and its afterInstall Verdict passed.
// What differs from a real update, so the rehearsal needs no network and stays short: the commit it installs has the `run` of each check
// of `.system/checks.yaml` replaced by `true` (the update's own run of the whole suite, `upgrade` included, would recurse). Every key,
// every `paths` and the `afterInstall` list are kept, so the old Host still reads the file as it would. `--add-check-key <name>` adds
// that key to the first check: the shape of Escaped defect 7, a key the running release refuses.
//   node tools/upgrade-rehearsal.mjs [--release <ref>] [--commit <ref>] [--add-check-key <name>] [--keep]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, stringify } from '../packages/verifiers/node_modules/yaml/dist/index.js'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const keep = argv.includes('--keep')
const log = (line) => process.stdout.write(`upgrade-rehearsal: ${line}\n`)
class Failed extends Error {}

// The install's origin must look like GitHub (`system bootstrap check` refuses another), yet nothing may touch the network: git reaches
// `git@github.com:...` through this ssh stand-in, which runs the remote command (`git-upload-pack '<path>'`) on the local bare origin.
const ORIGIN_URL = 'git@github.com:tsuuanmi/System.git'
const SSH_STANDIN = (origin) => [
  "import { spawnSync } from 'node:child_process'",
  `const origin = ${JSON.stringify(origin)}`,
  "const command = process.argv.at(-1).replace(/'[^']*'/, () => `'${origin}'`)",
  "process.exit(spawnSync('/bin/sh', ['-c', command], { stdio: 'inherit' }).status ?? 1)",
  '',
].join('\n')

const sh = (command, args, { cwd = repo, env = process.env, input } = {}) => {
  const ran = spawnSync(command, args, { cwd, env, input, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (ran.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${ran.status ?? ran.signal}): ${ran.stderr || ran.stdout}`)
  return ran.stdout.trim()
}
const git = (...args) => sh('git', args)
const gitIn = (cwd, env, ...args) => sh('git', args, { cwd, env })

function releaseRef() {
  const wanted = option('--release')
  for (const ref of wanted ? [wanted] : ['origin/main', 'main']) {
    if (spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repo }).status === 0) return ref
  }
  throw new Error('no last release to rehearse from: no origin/main or main in this clone (pass --release <ref>)')
}

/** The commit under check, with each check's `run` replaced (see the header); a commit of the repository's own objects, in a scratch index. */
function rehearsalCommit(scratch) {
  const named = option('--commit')
  const head = git('rev-parse', 'HEAD')
  const index = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') }
  gitIn(repo, index, 'read-tree', named ?? head)
  if (!named) gitIn(repo, index, 'add', '-A') // the working tree as it is, so an uncommitted change is rehearsed too
  const file = parse(gitIn(repo, index, 'show', ':.system/checks.yaml'))
  file.checks = file.checks.map((check) => ({ ...check, run: 'true' }))
  const key = option('--add-check-key')
  if (key) file.checks[0][key] = 1
  const blob = sh('git', ['hash-object', '-w', '--stdin'], { input: stringify(file) })
  gitIn(repo, index, 'update-index', '--cacheinfo', `100644,${blob},.system/checks.yaml`)
  const tree = gitIn(repo, index, 'write-tree')
  const env = { ...process.env, GIT_AUTHOR_NAME: 'rehearsal', GIT_AUTHOR_EMAIL: 'rehearsal@localhost', GIT_COMMITTER_NAME: 'rehearsal', GIT_COMMITTER_EMAIL: 'rehearsal@localhost' }
  return gitIn(repo, env, 'commit-tree', tree, '-p', named ?? head, '-m', 'upgrade rehearsal: the commit under check')
}

/** Run `system host --supervise` of the install; resolves once the Host listens. */
function startHost(cli, env) {
  const child = spawn(process.execPath, [cli, 'host', '--supervise'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  const exited = new Promise((done) => child.on('exit', (code) => done(code)))
  const listening = new Promise((ok, no) => {
    child.stderr.on('data', (data) => { stderr += data; if (/listening on /.test(stderr)) ok() })
    void exited.then(() => no(new Error(`the Host exited before answering: ${stderr}`)))
  })
  return { listening, stderr: () => stderr, stop: async () => { child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 10_000); await exited; clearTimeout(force) } }
}

async function rehearse(scratch) {
  const old = git('rev-parse', releaseRef())
  const next = rehearsalCommit(scratch)
  log(`the last release is ${old.slice(0, 12)}; the commit under check, as rehearsed, ${next.slice(0, 12)}`)
  const origin = join(scratch, 'origin.git')
  const install = join(scratch, 'i')
  const home = join(scratch, 'h')
  sh('git', ['init', '-q', '--bare', origin])
  const ssh = join(scratch, 'ssh.mjs')
  writeFileSync(ssh, SSH_STANDIN(origin))
  const gitEnv = { GIT_SSH_COMMAND: `${process.execPath} ${ssh}`, GIT_SSH_VARIANT: 'simple' }
  git('-c', 'core.hooksPath=/dev/null', 'push', '-q', origin, `${old}:refs/heads/main`)
  // The install `system update` leaves: repo/, releases/<commit>, current.
  mkdirSync(join(install, 'releases'), { recursive: true })
  sh('git', ['clone', '-q', '--no-checkout', ORIGIN_URL, join(install, 'repo')], { env: { ...process.env, ...gitEnv } })
  const release = join(install, 'releases', old)
  sh('git', ['-C', join(install, 'repo'), 'worktree', 'add', '-q', '--detach', release, old])
  log(`building the last release in ${release}`)
  // corepack beside this Node, and that Node first on PATH for its shim (Item ns-2).
  const corepack = join(dirname(process.execPath), 'corepack')
  const nodeEnv = { ...process.env, PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(':') }
  sh(corepack, ['pnpm', 'install', '--frozen-lockfile'], { cwd: release, env: nodeEnv })
  sh(corepack, ['pnpm', 'build'], { cwd: release, env: nodeEnv })
  sh('ln', ['-s', `releases/${old}`, join(install, 'current')])
  const cli = join(install, 'current', 'bin', 'system')
  const env = { ...process.env, DSH_HOME: home, SYSTEM_INSTALL: install, SYSTEM_NO_SERVICE: '1', SYSTEM_OPERATOR_ID: 'rehearsal', ...gitEnv }
  delete env.SYSTEM_CODE
  sh(process.execPath, [cli, 'init'], { env })
  const host = startHost(cli, env)
  try {
    await host.listening
    log('the last release\'s Host is up; publishing the commit under check as main (and dev) of the local origin')
    git('-c', 'core.hooksPath=/dev/null', 'push', '-q', '--force', origin, `${next}:refs/heads/main`, `${next}:refs/heads/dev`)
    const updated = await new Promise((done) => {
      const child = spawn(process.execPath, [cli, 'update', '--wait', '5'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { output += data; process.stdout.write(data) })
      child.on('exit', (code) => done({ code, output }))
    })
    const current = (() => { try { return readlinkSync(join(install, 'current')) } catch { return undefined } })()
    if (updated.code !== 0 || current !== `releases/${next}`) {
      const named = updated.output.trim().split('\n').filter((line) => /failed|invalid|refus|unknown|Unrecognized|error/i.test(line)).slice(-6).join('\n')
      throw new Failed(`\`system update\` of the last release exited ${updated.code} with current ${current ?? 'unset'} (wanted releases/${next}):\n${named || updated.output.trim().split('\n').slice(-6).join('\n')}`)
    }
    if (!updated.output.includes(`the install checks of ${next.slice(0, 12)} passed`)) throw new Failed('the update kept the new release but its afterInstall Verdict did not pass (no "install checks ... passed" line)')
    log(`ok: current is ${next.slice(0, 12)} and its afterInstall checks passed`)
  } finally {
    await host.stop()
  }
}

const scratch = mkdtempSync('/tmp/upg-')
try {
  await rehearse(scratch)
  console.log('upgrade rehearsal passed')
} catch (error) {
  console.log(`upgrade rehearsal failed: ${error instanceof Failed ? error.message : error.stack ?? error}`)
  process.exitCode = 1
} finally {
  if (keep) log(`kept ${scratch}`)
  else {
    spawnSync('git', ['worktree', 'prune'], { cwd: repo })
    rmSync(scratch, { recursive: true, force: true })
  }
}
