/**
 * `code.required-checks`: run a repository's required check commands on a
 * fresh worktree of the exact commit under judgment.
 *
 * Criteria are pinned at admission from `.system/checks.yaml` **at the task's
 * base commit**, so a Worker cannot weaken them by editing that file. Each
 * check runs `sh -c <run>` in the worktree with a minimal environment and its
 * own timeout; its exit, duration and output tails are one evidence Artifact.
 * Verdict: `pass` when every check exits 0 and leaves no Xvfb or Chrome running (it is named and killed), `fail` when any does not (a
 * timeout is a failure), `error` when the checks could not be run at all.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Spawner } from '@system/agents'
import type { Artifacts } from '@system/artifacts'
import { TASK_KIND, addWorktree, git, removeWorktree, type GitTreeContent, type Task, type VerifierPort, type VerifyResult } from '@system/work'
import { parse } from 'yaml'
import { z } from 'zod'

export const CHECKS_FILE = '.system/checks.yaml'
const TAIL = 16 * 1024

export const CHECKS_KIND = { kind: 'checks', schemaVersion: 1 } as const
export const checksFileSchema = z.object({
  checks: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    run: z.string().min(1),
    timeoutSeconds: z.number().int().positive().max(3600).default(600),
  }).strict()).min(1).max(20),
}).strict()
export const checksSchema = z.object({
  name: z.string(),
  source: z.object({ repository: z.string(), commit: z.string(), path: z.literal(CHECKS_FILE) }).strict(),
  checks: checksFileSchema.shape.checks,
}).strict()
export type Checks = z.infer<typeof checksSchema>

export const CHECK_RUN_KIND = { kind: 'check-run', schemaVersion: 1 } as const
export const checkRunSchema = z.object({
  name: z.string(),
  run: z.string(),
  commit: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  /** Xvfb and Chrome processes the check started and left running (stopped by the verifier), as `name pid N`. */
  leftovers: z.array(z.string()).optional(),
  durationMs: z.number().int().nonnegative(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
}).strict()

/** A display server or browser: what a check's own tests leak, and what then holds a Worker's pipes and profile. */
const LEAKED = /^(Xvfb|chrome|chromium|chrome-headless-shell)$/

/**
 * The Xvfb and Chrome processes a check left running: those of this user whose environment carries the check's own
 * throwaway HOME (children keep it, and a leaked process is reparented, so its ancestry is no help). Each is killed.
 */
export function stopLeftovers(home: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const name = readFileSync(`/proc/${entry}/comm`, 'utf8').trim()
      if (!LEAKED.test(name) || !readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(`HOME=${home}`)) continue
      process.kill(Number(entry), 'SIGKILL')
      found.push(`${name} pid ${entry}`)
    } catch {
      // Gone already, another user's, or no /proc (not Linux): nothing to name.
    }
  }
  return found
}

const tail = (text: string) => (text.length > TAIL ? text.slice(-TAIL) : text)

function contentOf<T>(artifacts: Artifacts, id: string, kind: string): T {
  const read = artifacts.get(id)
  if (read.state !== 'stored' || read.envelope.kind !== kind) throw new Error(`${id} is not a stored ${kind} Artifact`)
  return read.envelope.content as T
}

export function requiredChecks(artifacts: Artifacts, spawner: Spawner, now: () => number = Date.now): VerifierPort {
  const producer = { type: 'verifier' as const, ref: 'code.required-checks' }
  return {
    ref: 'code.required-checks',
    version: '1',
    capabilities: ['code.required-checks'],
    accepts: ['git-tree'],
    async criteria({ name, input }) {
      if (!input) throw new Error('the Work has no input task naming a repository')
      const task = contentOf<Task>(artifacts, input, TASK_KIND.kind)
      if (!task.base) throw new Error('the input task has no base commit (system task new --repo)')
      const base = contentOf<GitTreeContent>(artifacts, task.base, 'git-tree')
      let text: string
      try {
        text = await git(base.repository, ['show', `${base.commit}:${CHECKS_FILE}`])
      } catch {
        throw new Error(`no ${CHECKS_FILE} at commit ${base.commit} of ${base.repository}`)
      }
      const parsed = checksFileSchema.safeParse(parse(text))
      if (!parsed.success) throw new Error(`${CHECKS_FILE} at ${base.commit} is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
      const content: Checks = { name, source: { repository: base.repository, commit: base.commit, path: CHECKS_FILE }, checks: parsed.data.checks }
      return (await artifacts.put({ ...CHECKS_KIND, content, inputs: [task.base], classification: 'operator-shared', producer })).id
    },
    async verify(request): Promise<VerifyResult> {
      const verdict = (v: VerifyResult['verdict'], reason: string, evidence: string[]): VerifyResult => ({ verdict: v, reason, subject: request.subject, criteria: request.criteria, evidence })
      const tree = contentOf<GitTreeContent>(artifacts, request.subject, 'git-tree')
      const checks = contentOf<Checks>(artifacts, request.criteria, CHECKS_KIND.kind)
      const scratch = mkdtempSync(join(tmpdir(), 'system-checks-'))
      const worktree = join(scratch, 'work')
      try {
        await addWorktree(tree.repository, worktree, tree.commit)
      } catch (error) {
        rmSync(scratch, { recursive: true, force: true })
        return verdict('error', `could not check out ${tree.commit}: ${(error as Error).message}`, [])
      }
      const evidence: string[] = []
      const failed: string[] = []
      try {
        for (const check of checks.checks) {
          const started = now()
          const timeout = AbortSignal.timeout(check.timeoutSeconds * 1000)
          const spawned = spawner.spawn({
            argv: ['/bin/sh', '-c', check.run], cwd: worktree, signal: timeout, graceMs: 5000,
            env: { ...Object.fromEntries(Object.keys(process.env).map((k) => [k, undefined])), PATH: process.env.PATH, LANG: process.env.LANG, HOME: scratch, CI: '1' },
          })
          const outcome = await spawned.done
          const leftovers = stopLeftovers(scratch)
          const run = {
            name: check.name, run: check.run, commit: tree.commit, exitCode: outcome.exitCode, signal: outcome.signal,
            timedOut: timeout.aborted, durationMs: Math.max(0, Math.round(now() - started)),
            stdoutTail: tail(spawned.stdout()), stderrTail: tail(spawned.stderr()), ...(leftovers.length ? { leftovers } : {}),
          }
          evidence.push((await artifacts.put({ ...CHECK_RUN_KIND, content: run, inputs: [request.subject, request.criteria], classification: 'local-private', producer })).id)
          if (run.exitCode !== 0 || run.timedOut) failed.push(run.timedOut ? `${check.name} (timed out after ${check.timeoutSeconds} s)` : `${check.name} (exit ${run.exitCode ?? run.signal})`)
          else if (leftovers.length) failed.push(`${check.name} (left running: ${leftovers.join(', ')})`)
        }
      } finally {
        await removeWorktree(tree.repository, worktree)
        rmSync(scratch, { recursive: true, force: true })
      }
      return failed.length
        ? verdict('fail', `failed: ${failed.join(', ')}`, evidence)
        : verdict('pass', `all ${checks.checks.length} check(s) passed on ${tree.commit}`, evidence)
    },
  }
}
