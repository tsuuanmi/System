/**
 * The Account's `sandbox` option (ADR-0016 decisions 2, 3, 6): one bubblewrap layer around a CLI Runtime's process, the same OS user.
 * Pure: the argv goes in and comes out, and the host's facts (the passwd home, the repository's git directory, where `bwrap` is) are arguments.
 *
 * Hidden: the passwd home (not `$HOME`, which is the attempt's throwaway directory), so `~/.ssh` too, and the Host's state under `$DSH_HOME/system`.
 * Bound: the attempt's own directory read-write, the repository's git data read-write with its `config` and `hooks/` read-only over it (the attempt can
 * commit, and cannot plant a hook the Host would run), the toolchain read-only. The network is kept.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, lstatSync } from 'node:fs'
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

/** The layer around `argv`, or why there is none: the facts are read here, and nothing runs. `command` is the Runtime's binary, `env` the variables it will get. */
export function sandboxed(argv: string[], ws: Workspace, input: { state: string; command: string; env: Record<string, string> }, host: SandboxHost = realHost()): { argv: string[] } | { failed: string } {
  const bwrap = host.bwrap()
  if (!bwrap) return { failed: `${SANDBOX_LAYER_UNAVAILABLE}: bwrap is not on the PATH` }
  if (!host.works(bwrap)) return { failed: `${SANDBOX_LAYER_UNAVAILABLE}: ${bwrap} cannot create a user namespace here` }
  const home = host.home()
  const real = (path: string) => { try { return realpathSync(path) } catch { return path } }
  // What lies under the hidden home and the attempt needs: a PATH entry (and its parent, as nvm's `lib` lies beside `bin`) and the Runtime's binary.
  const dirs = [...(input.env.PATH ?? '').split(delimiter).filter(isAbsolute).flatMap((d) => [d, dirname(d)]), dirname(input.command), dirname(real(input.command))]
  const readOnly = [...new Set(dirs.filter((d) => under(home, d) && existsSync(d)))]
  // The attempt home may link to an Account's state (Antigravity's `.gemini`): it is bound where it lies, read-write, as the login refreshes in place.
  const readWrite = existsSync(ws.home) ? readdirSync(ws.home).map((name) => join(ws.home, name)).filter((p) => lstatSync(p).isSymbolicLink()).map(real).filter((p) => existsSync(p) && (under(input.state, p) || under(home, p)) && !under(ws.root, p)) : []
  const dir = host.gitCommonDir(ws.work)
  return { argv: sandboxArgv(argv, ws, { bwrap, home, state: input.state, ...(dir ? { common: { dir, hooks: existsSync(join(dir, 'hooks')) } } : {}), readOnly, readWrite }) }
}
