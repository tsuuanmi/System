/**
 * The skip decision of the bubblewrap layer tests (ADR-0016): run when bubblewrap starts, skip with the reason when it cannot, and fail
 * instead of skipping when `SYSTEM_REQUIRE_SANDBOX=1` (the build check on GitHub sets it, so a layer defect cannot pass unseen).
 */
import { spawnSync } from 'node:child_process'

export type LayerDecision = { decision: 'run' } | { decision: 'skip' | 'fail'; reason: string }

/** Whether `bwrap` (a path or a name looked up on PATH) starts a namespace; undefined means no bubblewrap at all. */
export const bwrapStarts = (bwrap: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean =>
  !!bwrap && spawnSync(bwrap, ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', 'true'], { stdio: 'ignore', env }).status === 0

export function layerDecision(bwrap: string | undefined, reason: string, env: NodeJS.ProcessEnv = process.env): LayerDecision {
  if (bwrapStarts(bwrap, env)) return { decision: 'run' }
  return { decision: env.SYSTEM_REQUIRE_SANDBOX === '1' ? 'fail' : 'skip', reason }
}

/** The value of a test's `skip` option: false to run, the reason to skip; it throws, naming the reason, when SYSTEM_REQUIRE_SANDBOX=1 forbids a skip. */
export function layerSkip(bwrap: string | undefined, reason: string, env: NodeJS.ProcessEnv = process.env): string | false {
  const d = layerDecision(bwrap, reason, env)
  if (d.decision === 'fail') throw new Error(`SYSTEM_REQUIRE_SANDBOX=1 but the layer tests cannot run: ${d.reason}`)
  return d.decision === 'skip' ? d.reason : false
}
