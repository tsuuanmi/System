// What `bin/system` decides before it runs DSH: which Node to use, and whether
// `system init` installs the systemd user unit. Plain JavaScript that needs no
// build, so it also runs under the Node it replaces.
import { basename, dirname, join } from 'node:path'

export const MIN_NODE = '24.9.0'

const parse = (version) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number)
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** Whether `current` (such as `process.versions.node`) will do, else the newest installed Node 24 that will; `installed` are directory names like `v24.21.0`. */
export function nodeChoice(current, installed) {
  const min = parse(MIN_NODE)
  if (compare(parse(current), min) >= 0) return { use: 'current' }
  const best = installed
    .map((name) => ({ name, v: parse(name) }))
    .filter((c) => c.v && c.v[0] === 24 && compare(c.v, min) >= 0)
    .sort((a, b) => compare(b.v, a.v))[0]
  return best ? { use: 'other', version: best.name } : { use: 'none' }
}

/** The exit status of a Host that stopped to run new code (EX_TEMPFAIL): the same as `UPGRADE_EXIT` in packages/host, which a test holds equal. */
export const UPGRADE_EXIT = 75

/** The options of `dsh` that take a value (`dsh --help`); the others stand alone. */
const VALUE_OPTIONS = ['--profile', '--patch', '--from-default-profile']

/** Whether the command is `host`: the first argument that is not a global option of dsh nor the value of one. */
export function hostCommand(args) {
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('-')) return args[i] === 'host'
    if (VALUE_OPTIONS.includes(args[i])) i++
  }
  return false
}

export const unitPath = (homedir) => join(homedir, '.config', 'systemd', 'user', 'system.service')

/** One word of a unit line: systemd expands `%` and `$`, and splits on spaces unless quoted. */
function word(text) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/%/g, '%%').replace(/\$/g, '$$$$')
  return /[\s"']/.test(text) ? `"${escaped.replace(/"/g, '\\"')}"` : escaped
}

/**
 * The code a Host runs and watches: for a release under `<install>/releases/<commit>`
 * (`system update`), the install's `current` link, so a switch of that link is new code;
 * for a checkout, the checkout itself.
 */
export function installRoot(repo, exists) {
  const install = dirname(dirname(repo))
  return basename(dirname(repo)) === 'releases' && exists(join(install, 'current')) ? join(install, 'current') : repo
}

/** The `system.service` text: a plain user unit running `system host` (with the install's profile as a patch, if any), with no socket activation. */
export function unitText({ node, entry, home, path, patch }) {
  return `[Unit]
Description=System Host: the one process that owns this home's Work
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
ExecStart=${word(node)} ${word(entry)}${patch ? ` --patch ${word(patch)}` : ''} host
Environment=${word(`DSH_HOME=${home}`)}
Environment=${word(`PATH=${path}`)}
Restart=on-failure
RestartForceExitStatus=75
RestartSec=5

[Install]
WantedBy=default.target
`
}

/** How many times a Host that fails after an upgrade is started again, and the first wait (doubled each time). */
export const UPGRADE_RETRIES = 3
const RETRY_MS = 2000

/**
 * `system host --supervise`: run the Host with `run` (it resolves the exit status), and again after
 * `UPGRADE_EXIT`. The code it then starts may still be half built, so a failure that follows an upgrade is
 * tried again `UPGRADE_RETRIES` times, waiting 2, 4 and 8 s; a later upgrade starts the count again. Any
 * other status ends the supervisor with it, as does a stop asked of the supervisor itself (`stopped()`).
 */
export async function supervise({ run, stopped, log, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let upgraded = false
  let tries = 0
  for (;;) {
    const code = await run()
    if (stopped()) return code
    if (code === UPGRADE_EXIT) {
      log('restarting: the Host stopped to upgrade to the code on disk')
      upgraded = true
      tries = 0
      continue
    }
    if (code === 0 || !upgraded) return code
    if (tries === UPGRADE_RETRIES) {
      log(`the Host exited ${code} after the upgrade ${UPGRADE_RETRIES + 1} times; gave up`)
      return code
    }
    const ms = RETRY_MS * 2 ** tries++
    log(`the Host exited ${code} after the upgrade; trying again in ${ms / 1000} s (${tries} of ${UPGRADE_RETRIES})`)
    await wait(ms)
  }
}

/**
 * What `system init` does about the service: `install` the unit (the default
 * home on Linux), `skip` it (asked not to, or not Linux), or `foreground` (any
 * other home runs `system host` by hand).
 */
export function serviceMode({ home, homedir, platform, args, env }) {
  if (args.includes('--no-service') || env.SYSTEM_NO_SERVICE === '1') return 'skip'
  if (platform !== 'linux') return 'skip'
  return home.replace(/\/+$/, '') === join(homedir, '.dsh') ? 'install' : 'foreground'
}
