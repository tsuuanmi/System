/**
 * The Account's `sandbox` option (ADR-0016 decisions 2, 3, 6): one bubblewrap layer around a CLI Runtime's process, the same OS user.
 * Pure: the argv goes in and comes out, and the host's facts (the passwd home, the repository's git directory, where `bwrap` is) are arguments.
 *
 * Hidden: the passwd home (not `$HOME`, which is the attempt's throwaway directory), so `~/.ssh` too, and the Host's state under `$DSH_HOME/system`.
 * Bound, and all that is bound (the one statement; adapters/README.md points here):
 *  - the attempt's own directory, read-write;
 *  - the repository's git data read-write with its `config` and `hooks/` read-only over it (the attempt can commit, and cannot plant a hook the Host would run);
 *  - read-only, from under the passwd home: each PATH entry itself, plus what its own files need (`needsOf`: the directory of the real path of a link that
 *    leaves the entry, the `lib` beside a `bin` that a link or a binary's `$ORIGIN/../lib` names, a `#!` interpreter's real directory), and the Runtime's
 *    binary by its real path's directory and no wider; never a PATH entry's parent as such;
 *  - read-write, each link anywhere under the attempt's home to an Account's state (`$DSH_HOME/system` or the home), by its target, unless the target is inside the attempt's root.
 * The network is kept.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync, lstatSync, statSync, type Dirent } from 'node:fs'
import { userInfo } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path'
import type { Workspace } from '../workspace.ts'

/** The Account's option: `true`. The keys of sb-1 (`allowRead`, `allowedDomains`) are gone with Claude Code's own sandbox. */
export type SandboxOption = true

/** What the host says; a test injects it. */
export interface SandboxHost {
  /** The operator's real home: the passwd entry, never $HOME. */
  home(): string
  /** The absolute path of `bwrap` on the PATH, or undefined. */
  bwrap(): string | undefined
  /** Whether bubblewrap can start here (unprivileged user namespaces may be off). */
  works(bwrap: string): boolean
  /** The common git directory of the worktree at `work`, absolute, or undefined when it is not one. */
  gitCommonDir(work: string): string | undefined
}

const probed = new Set<string>()

/** The real host; `path` is where `bwrap` is looked for (the process's PATH by default, read at each call). */
export const realHost = (path?: string): SandboxHost => ({
  home: () => userInfo().homedir,
  bwrap: () => (path ?? process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map((d) => join(d, 'bwrap')).find((f) => existsSync(f)),
  works(bwrap) {
    if (probed.has(bwrap)) return true
    const ok = spawnSync(bwrap, ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--die-with-parent', 'true'], { stdio: 'ignore' }).status === 0
    if (ok) probed.add(bwrap)
    return ok
  },
  gitCommonDir(work) {
    try {
      return execFileSync('git', ['-C', work, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
    } catch {
      return undefined
    }
  },
})

/** The reason of an attempt that cannot get its layer (it never runs unwrapped). */
export const SANDBOX_LAYER_UNAVAILABLE = 'the sandbox layer cannot start'

/** The Account's `sandbox` option, checked: `true`, or why it is refused. */
export function parseSandbox(value: unknown): SandboxOption | undefined {
  if (value === undefined) return undefined
  if (value !== true) throw new Error('sandbox must be true (the keys of the Claude Code sandbox of sb-1 are gone)')
  return true
}

export interface SandboxPlan {
  bwrap: string
  /** The passwd home. */
  home: string
  /** `$DSH_HOME/system`. */
  state: string
  common?: { dir: string; hooks: boolean }
  /** Read-only binds, after the home is hidden. */
  readOnly: string[]
  /** What the attempt's home links to (an Account's login), read-write. */
  readWrite: string[]
}

/** The argv of a Runtime process inside the layer. */
export function sandboxArgv(argv: string[], ws: Workspace, plan: SandboxPlan): string[] {
  const bind = (flag: '--bind' | '--ro-bind', path: string) => [flag, path, path]
  const { common } = plan
  return [
    plan.bwrap, '--die-with-parent', '--unshare-pid',
    '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
    '--tmpfs', plan.home, '--tmpfs', plan.state,
    ...bind('--bind', ws.root),
    ...(common ? [...bind('--bind', common.dir), ...bind('--ro-bind', join(common.dir, 'config')), ...(common.hooks ? bind('--ro-bind', join(common.dir, 'hooks')) : ['--ro-bind', '/dev/null', join(common.dir, 'hooks')])] : []),
    ...plan.readOnly.flatMap((path) => bind('--ro-bind', path)),
    ...plan.readWrite.flatMap((path) => bind('--bind', path)),
    '--chdir', ws.work, '--', ...argv,
  ]
}

const under = (home: string, path: string) => { const r = relative(home, path); return r !== '' && !r.startsWith('..') && !isAbsolute(r) }
const within = (dir: string, path: string) => path === dir || under(dir, path)

/** How much of an executable is read to see what it names: a shebang is on its first line, an ELF's `$ORIGIN/../lib` run path in its early dynamic strings. */
const HEAD = 64 * 1024
/** A PATH entry with more files than this is not read further (it is bound as a directory all the same). */
const MAX_ENTRIES = 500

/**
 * What a PATH entry needs besides itself, by what its own files say (never a list of directory names):
 *  - a link that leaves the entry needs the directory of its real path, and no wider;
 *  - a link into `<prefix>/lib`, or a binary naming `$ORIGIN/../lib`, where `<prefix>` is the directory above the entry's real path, needs
 *    that `lib` (nvm's `bin/npm` is a link into `../lib/node_modules`, a JDK's `java` finds `../lib`);
 *  - a `#!` interpreter needs the directory of its real path.
 * Only paths under `home` are returned: the rest of the machine is visible already.
 */
export function needsOf(entry: string, home: string, real: (path: string) => string = realpathOrSelf): string[] {
  const out = new Set<string>([real(entry)])
  if (entry !== real(entry)) out.add(entry)
  const bin = real(entry), prefix = dirname(bin), lib = join(prefix, 'lib')
  let names: string[] = []
  try { names = readdirSync(bin).slice(0, MAX_ENTRIES) } catch { /* not a directory */ }
  for (const name of names) {
    const path = join(bin, name), target = real(path)
    if (target === path && !lstatOf(path)?.isFile()) continue
    if (!within(bin, target)) out.add(within(lib, target) ? lib : dirname(target))
    const head = headOf(target)
    if (head === undefined) continue
    if (head.startsWith('#!')) {
      const interpreter = head.slice(2).split('\n')[0]!.trim().split(/\s+/)[0]
      if (interpreter && isAbsolute(interpreter)) out.add(dirname(real(interpreter)))
    } else if (head.includes('$ORIGIN/../lib')) out.add(lib)
  }
  return [...out].filter((d) => under(home, d) && existsSync(d))
}

const realpathOrSelf = (path: string) => { try { return realpathSync(path) } catch { return path } }
const lstatOf = (path: string) => { try { return lstatSync(path) } catch { return undefined } }
const headOf = (path: string): string | undefined => {
  let fd: number | undefined
  try {
    if (!statSync(path).isFile()) return undefined
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(HEAD)
    return buf.toString('latin1', 0, readSync(fd, buf, 0, HEAD, 0))
  } catch { return undefined } finally { if (fd !== undefined) closeSync(fd) }
}

/** The links anywhere under `dir` (not followed), at most `depth` levels down. */
function linksUnder(dir: string, depth = 6): string[] {
  let entries: Dirent[] = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  return entries.flatMap((e) => (e.isSymbolicLink() ? [join(dir, e.name)] : e.isDirectory() && depth > 0 ? linksUnder(join(dir, e.name), depth - 1) : []))
}

/** The layer around `argv`, or why there is none: the facts are read here, and nothing runs. `command` is the Runtime's binary, `env` the variables it will get. */
export function sandboxed(argv: string[], ws: Workspace, input: { state: string; command: string; env: Record<string, string> }, host: SandboxHost = realHost()): { argv: string[] } | { failed: string } {
  const bwrap = host.bwrap()
  if (!bwrap) return { failed: `${SANDBOX_LAYER_UNAVAILABLE}: bwrap is not on the PATH` }
  if (!host.works(bwrap)) return { failed: `${SANDBOX_LAYER_UNAVAILABLE}: ${bwrap} cannot create a user namespace here` }
  const home = host.home()
  // Under the hidden home: each PATH entry with what its own files need (`needsOf`), and the Runtime's binary by its real directory, no wider.
  const entries = (input.env.PATH ?? '').split(delimiter).filter(isAbsolute).filter((d) => under(home, d) && existsSync(d))
  const command = isAbsolute(input.command) && under(home, input.command) && existsSync(input.command) ? [realpathOrSelf(input.command)] : []
  const all = [...new Set([...entries.flatMap((d) => needsOf(d, home)), ...command.map(dirname), ...(command.length && !entries.some((d) => within(d, input.command)) ? [input.command] : [])])]
  const readOnly = all.filter((d) => !all.some((o) => o !== d && within(o, d) && lstatOf(o)?.isDirectory() && !lstatOf(o)?.isSymbolicLink()))
  // Links anywhere in the attempt home to an Account's state (Antigravity's `.gemini/antigravity-cli/...`): bound where they lie, read-write, as the login refreshes in place.
  const readWrite = [...new Set(linksUnder(ws.home).map(realpathOrSelf).filter((p) => existsSync(p) && (under(input.state, p) || under(home, p)) && !under(ws.root, p)))]
  const dir = host.gitCommonDir(ws.work)
  return { argv: sandboxArgv(argv, ws, { bwrap, home, state: input.state, ...(dir ? { common: { dir, hooks: existsSync(join(dir, 'hooks')) } } : {}), readOnly, readWrite }) }
}
