// What `bin/system` decides before it runs DSH: which Node to use, and whether
// `system init` installs the systemd user unit. Plain JavaScript that needs no
// build, so it also runs under the Node it replaces.
import { join } from 'node:path'

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

export const unitPath = (homedir) => join(homedir, '.config', 'systemd', 'user', 'system.service')

/** One word of a unit line: systemd expands `%` and `$`, and splits on spaces unless quoted. */
function word(text) {
  const escaped = text.replace(/\\/g, '\\\\').replace(/%/g, '%%').replace(/\$/g, '$$$$')
  return /[\s"']/.test(text) ? `"${escaped.replace(/"/g, '\\"')}"` : escaped
}

/** The `system.service` text: a plain user unit running `system host`, with no socket activation. */
export function unitText({ node, entry, home, path }) {
  return `[Unit]
Description=System Host: the one process that owns this home's Work

[Service]
ExecStart=${word(node)} ${word(entry)} host
Environment=${word(`DSH_HOME=${home}`)}
Environment=${word(`PATH=${path}`)}
Restart=on-failure

[Install]
WantedBy=default.target
`
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
