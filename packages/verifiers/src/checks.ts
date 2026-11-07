/**
 * `code.required-checks`: run a repository's required check commands on a
 * fresh worktree of the exact commit under judgment.
 *
 * Criteria are pinned at admission from `.system/checks.yaml` **at the task's
 * base commit**, so a Worker cannot weaken them by editing that file. Each
 * check runs `sh -c <run>` in the worktree with a minimal environment and its
 * own timeout; its exit, duration and output tails are one evidence Artifact.
 * Verdict: `pass` when every check exits 0, `fail` when any does not (a
 * timeout is a failure), `error` when the checks could not be run at all.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, matchesGlob } from 'node:path'
import type { Spawner } from '@system/agents'
import type { Artifacts } from '@system/artifacts'
import { TASK_KIND, addWorktree, git, removeWorktree, type GitTreeContent, type Task, type VerifierPort, type VerifyResult } from '@system/work'
import { parse } from 'yaml'
import { firstFailure, interrupted, nodeBin } from './reasons.ts'
import { z } from 'zod'

export const CHECKS_FILE = '.system/checks.yaml'
const TAIL = 16 * 1024

export const CHECKS_KIND = { kind: 'checks', schemaVersion: 1 } as const
export const checksFileSchema = z.object({
  checks: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    run: z.string().min(1),
    timeoutSeconds: z.number().int().positive().max(3600).default(600),
    /** Globs (GitHub Actions' `paths`): the check runs only when the change touches one; without it, always. */
    paths: z.array(z.string().min(1)).min(1).optional(),
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
  durationMs: z.number().int().nonnegative(),
  stdoutTail: z.string(),
  stderrTail: z.string(),
}).strict()

/** Whether a check runs for a change touching `touched` (paths relative to the repository): always without `paths`. */
export const selected = (check: { paths?: string[] }, touched: readonly string[]): boolean =>
  !check.paths || touched.some((file) => check.paths!.some((glob) => matchesGlob(file, glob)))

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
    // A task on its own (code-checks.yaml alone) has its base commit checked as it is.
    accepts: ['git-tree', 'task'],
    async criteria({ name, input }) {
      if (!input) throw new Error('the Work has no input task naming a repository')
      // The checks come from a base the Worker did not write, never from the change itself.
      const read = artifacts.get(input)
      if (read.state !== 'stored' || read.envelope.kind !== TASK_KIND.kind) throw new Error('the checks are pinned from a task with a base commit (system task new --repo), not from the change itself')
      const task = read.envelope.content as Task
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
      const subject = artifacts.get(request.subject)
      const treeId = subject.state === 'stored' && subject.envelope.kind === TASK_KIND.kind ? (subject.envelope.content as Task).base ?? '' : request.subject
      const tree = contentOf<GitTreeContent>(artifacts, treeId, 'git-tree')
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
      const ran: string[] = []
      const skipped: string[] = []
      try {
        // The repository's Node first on PATH, whatever the Host's PATH has (PROP-0007 decision 3).
        let bin: string | undefined
        try {
          bin = nodeBin(worktree)
        } catch (error) {
          return verdict('error', (error as Error).message, [])
        }
        const path = [bin, process.env.PATH].filter(Boolean).join(':')
        // What the change touches against the base its checks were pinned from (PROP-0007 decision 5).
        const touched = (await git(tree.repository, ['diff', '--name-only', checks.source.commit, tree.commit])).split('\n').filter(Boolean)
        for (const check of checks.checks) {
          if (!selected(check, touched)) {
            skipped.push(check.name)
            continue
          }
          const started = now()
          // `timeout` interrupts the whole group first, so a test runner says what it was running; the abort is the backstop.
          const backstop = AbortSignal.timeout((check.timeoutSeconds + 20) * 1000)
          const spawned = spawner.spawn({
            argv: ['timeout', '-s', 'INT', '-k', '10', String(check.timeoutSeconds), '/bin/sh', '-c', check.run], cwd: worktree, signal: backstop, graceMs: 5000,
            env: { ...Object.fromEntries(Object.keys(process.env).map((k) => [k, undefined])), PATH: path, LANG: process.env.LANG, HOME: scratch, CI: '1' },
          })
          const outcome = await spawned.done
          const output = `${spawned.stdout()}\n${spawned.stderr()}`
          const run = {
            name: check.name, run: check.run, commit: tree.commit, exitCode: outcome.exitCode, signal: outcome.signal,
            timedOut: backstop.aborted || outcome.exitCode === 124, durationMs: Math.max(0, Math.round(now() - started)),
            stdoutTail: tail(spawned.stdout()), stderrTail: tail(spawned.stderr()),
          }
          evidence.push((await artifacts.put({ ...CHECK_RUN_KIND, content: run, inputs: [request.subject, request.criteria], classification: 'local-private', producer })).id)
          ran.push(`${check.name} ${(run.durationMs / 1000).toFixed(1)} s`)
          if (run.timedOut) {
            const running = interrupted(output)
            failed.push(running.length ? `${check.name}: timed out after ${check.timeoutSeconds} s while running ${running.join(', ')}` : `${check.name} (timed out after ${check.timeoutSeconds} s)`)
          } else if (run.exitCode !== 0) {
            const first = firstFailure(output)
            failed.push(first ? `${check.name}: ${first}` : `${check.name} (exit ${run.exitCode ?? run.signal})`)
          }
        }
      } finally {
        await removeWorktree(tree.repository, worktree)
        rmSync(scratch, { recursive: true, force: true })
      }
      const which = `run: ${ran.join(', ')}${skipped.length ? `; skipped: ${skipped.join(', ')}` : ''}`
      return failed.length
        ? verdict('fail', `failed: ${failed.join('; ')}${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}`, evidence)
        : verdict('pass', `all ${ran.length} check(s) run passed on ${tree.commit}; ${which}`, evidence)
    },
  }
}
