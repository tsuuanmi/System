// What `bin/system` decides before it runs DSH: which Node to use, and whether
// `system init` installs the systemd user unit. Plain JavaScript that needs no
// build, so it also runs under the Node it replaces.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

/** Unquote and unescape the `ExecStart=` words of a systemd unit and return the `--patch` overlay paths in order. */
export function unitOverlays(text) {
  const line = /^ExecStart=(.*)$/m.exec(text)?.[1]
  if (!line) return []
  const words = []
  let current = ''
  let inWord = false
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) { quote = ''; continue }
      if (quote === '"' && ch === '\\' && i + 1 < line.length) { current += line[++i]; continue }
    } else {
      if (/\s/.test(ch)) {
        if (inWord) { words.push(current); current = ''; inWord = false }
        continue
      }
      inWord = true
      if (ch === '"' || ch === "'") { quote = ch; continue }
      if (ch === '\\' && i + 1 < line.length) { current += line[++i]; continue }
    }
    if ((ch === '%' || ch === '$') && line[i + 1] === ch) i++
    current += ch
  }
  if (inWord) words.push(current)
  const overlays = []
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '--patch' && i + 1 < words.length) overlays.push(words[++i])
    else if (words[i].startsWith('--patch=')) overlays.push(words[i].slice('--patch='.length))
  }
  return overlays
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

/**
 * The install's profile file (`<install>/profile.yml`, beside `releases/` and `current`) for the release
 * directory `repo`, or undefined for a checkout. The one place that path is decided: `bin/system` (the
 * unit's patch) asks here.
 */
export function installProfile(repo, exists) {
  const install = installRoot(repo, exists)
  return install === repo ? undefined : join(dirname(install), 'profile.yml')
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

/** The Schedule files' directory of an install (`~/.system/schedules`, or under `SYSTEM_INSTALL`). */
export const schedulesDir = (installBase) => join(installBase, 'schedules')

const scheduleUnit = (name, kind) => `system-schedule-${name}.${kind}`

/** The `system-schedule-<name>.service` text (ADR-0020 decision 6): one pass of the install's `system items carry --schedule <file>`, once the Host answers. */
export function scheduleServiceText({ name, node, entry, home, path, file }) {
  const wait = 'for i in 1 2 3 4 5 6 7 8 9 10; do "$@" >/dev/null 2>&1 && exit 0; sleep 30; done; echo "the Host does not answer" >&2; exit 1'
  return `[Unit]
Description=${`System Scheduled session: Schedule ${name}`}

[Service]
Type=oneshot
Environment=${word(`DSH_HOME=${home}`)}
Environment=${word(`PATH=${path}`)}
# Wait up to 5 minutes for the Host: \`system doctor\` exits 1 until it answers.
ExecStartPre=/bin/sh -c ${word(wait)} sh ${word(node)} ${word(entry)} doctor
ExecStart=${word(node)} ${word(entry)} items carry --schedule ${word(file)}
`
}

/** The `system-schedule-<name>.timer` text: one `OnCalendar=` for each `at`; a start missed while the machine was off is not run late. */
export function scheduleTimerText({ name, at }) {
  return `[Unit]
Description=${`System Scheduled session timer: Schedule ${name}`}

[Timer]
${at.map((expression) => `OnCalendar=${expression}`).join('\n')}
Persistent=false

[Install]
WantedBy=timers.target
`
}

/** The `system-schedule-<name>-check.service` text (sch-5): the check before a pass; no wait for the Host, since a Host that does not answer is what it reports. */
export function scheduleCheckServiceText({ name, node, entry, home, path, file }) {
  return `[Unit]
Description=${`System Scheduled session check: Schedule ${name}`}

[Service]
Type=oneshot
Environment=${word(`DSH_HOME=${home}`)}
Environment=${word(`PATH=${path}`)}
ExecStart=${word(node)} ${word(entry)} items carry --schedule ${word(file)} --check
`
}

/** File name to text of the units of each Schedule (`{ name, file, at, checkAt? }`); `checkAt` adds the check's service and timer. */
export function scheduleUnits({ node, entry, home, path, schedules }) {
  const units = new Map()
  for (const { name, file, at, checkAt } of schedules) {
    units.set(scheduleUnit(name, 'service'), scheduleServiceText({ name, node, entry, home, path, file }))
    units.set(scheduleUnit(name, 'timer'), scheduleTimerText({ name, at }))
    if (checkAt === undefined) continue
    units.set(scheduleUnit(`${name}-check`, 'service'), scheduleCheckServiceText({ name, node, entry, home, path, file }))
    units.set(scheduleUnit(`${name}-check`, 'timer'), scheduleTimerText({ name: `${name} check`, at: [checkAt] }))
  }
  return units
}

/**
 * Make `dir` hold `wanted` (file name to text) among its `system-schedule-*` units: write the new and changed ones,
 * remove those no Schedule wants any more. `keep` are names of Schedule files that exist but did not parse: their
 * earlier units stay as they are. Never enables or starts anything.
 */
export function syncScheduleUnits(dir, wanted, keep) {
  mkdirSync(dir, { recursive: true })
  const written = []
  const removed = []
  for (const [file, text] of wanted) {
    const path = join(dir, file)
    if (existsSync(path) && readFileSync(path, 'utf8') === text) continue
    writeFileSync(path, text)
    written.push(file)
  }
  for (const file of readdirSync(dir).sort()) {
    const stem = /^system-schedule-(.+)\.(?:service|timer)$/.exec(file)?.[1]
    if (stem === undefined || wanted.has(file) || keep.some((name) => stem === name || stem.startsWith(`${name}-`))) continue
    rmSync(join(dir, file))
    removed.push(file)
  }
  return { written, removed }
}
