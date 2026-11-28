/**
 * `release.install-check` (Item fl-5): run the `afterInstall` checks of a release commit against the installed release.
 *
 * Subject: the release commit's git tree (or a task whose base it is). Criteria `install-check-v1`: the `afterInstall` list of
 * `.system/checks.yaml` at that commit, pinned as a `checks@1` Artifact. Each command runs `sh -c` in a worktree of the commit with
 * the install's `current/bin` first on PATH, so `system` is the installed one, not the checkout's, and with the Host's own
 * environment (the checks talk to the Host). Every check runs; its exit, duration and output tails are one evidence Artifact.
 * Verdict: `pass` when every check exits 0, `fail` when any does not (a timeout is a failure; the reason names each failed check with its
 * first failing line), `error` when the commit cannot be checked out. `system update` uses it after the Host runs the release; no Workflow
 * file of the repository pins it (the Q0 rule: the running Host's verifiers must know what a release is checked with).
 */
import { mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Spawner } from '@system/runtime-cli/contract'
import type { Artifacts } from '@system/artifacts/contract'
import { addWorktree, git, removeWorktree } from '@system/git'
import type { GitTreeContent, Task, VerifyResult } from '@system/work'
import { TASK_KIND, type VerifierPort } from '@system/work/contract'
import { CHECKS_FILE, CHECKS_KIND, CHECK_RUN_KIND, parseChecksFile, type Checks } from './checks.ts'
import { firstFailure, interrupted } from './reasons.ts'

export const INSTALL_CHECK_V1 = 'install-check-v1'
const TAIL = 16 * 1024
const tail = (text: string) => (text.length > TAIL ? text.slice(-TAIL) : text)

/** The `bin` of the install's `current` link (`SYSTEM_INSTALL`, default `~/.system`, as `system update` finds it). */
const installedBin = (): string => join(process.env.SYSTEM_INSTALL || join(homedir(), '.system'), 'current', 'bin')

export function installCheck(artifacts: Artifacts, spawner: Spawner, bin: string = installedBin(), now: () => number = Date.now): VerifierPort {
  const producer = { type: 'verifier' as const, ref: 'release.install-check' }
  const treeOf = (id: string): GitTreeContent => {
    const read = artifacts.get(id)
    const treeId = read.state === 'stored' && read.envelope.kind === TASK_KIND.kind ? (read.envelope.content as Task).base ?? '' : id
    const tree = artifacts.get(treeId)
    if (tree.state !== 'stored' || tree.envelope.kind !== 'git-tree') throw new Error(`${id} is not a git tree or a task with a base`)
    return tree.envelope.content as GitTreeContent
  }
  return {
    ref: 'release.install-check',
    version: '1',
    capabilities: ['release.install-check'],
    accepts: ['git-tree', 'task'],
    async criteria({ name, input }) {
      if (name !== INSTALL_CHECK_V1) throw new Error(`unknown criteria ${name} for release.install-check; known: ${INSTALL_CHECK_V1}`)
      if (!input) throw new Error('the Work has no input task naming the release commit')
      const read = artifacts.get(input)
      if (read.state !== 'stored' || read.envelope.kind !== TASK_KIND.kind) throw new Error('the install checks are pinned from a task with a base commit (system task new --repo)')
      const task = read.envelope.content as Task
      if (!task.base) throw new Error('the input task has no base commit (system task new --repo)')
      const tree = treeOf(task.base)
      let text: string
      try {
        text = await git(tree.repository, ['show', `${tree.commit}:${CHECKS_FILE}`])
      } catch {
        throw new Error(`no ${CHECKS_FILE} at commit ${tree.commit} of ${tree.repository}`)
      }
      const parsed = parseChecksFile(text)
      if ('problem' in parsed) throw new Error(`${CHECKS_FILE} at ${tree.commit} is invalid: ${parsed.problem}`)
      if (!parsed.afterInstall) throw new Error(`no afterInstall checks in ${CHECKS_FILE} at ${tree.commit}`)
      const content: Checks = { name: INSTALL_CHECK_V1, source: { repository: tree.repository, commit: tree.commit, path: CHECKS_FILE }, checks: parsed.afterInstall }
      return (await artifacts.put({ ...CHECKS_KIND, content, inputs: [task.base], classification: 'operator-shared', producer })).id
    },
    async verify(request): Promise<VerifyResult> {
      const result = (verdict: VerifyResult['verdict'], reason: string, evidence: string[]): VerifyResult => ({ verdict, reason, subject: request.subject, criteria: request.criteria, evidence })
      const tree = treeOf(request.subject)
      const pinned = artifacts.get(request.criteria)
      if (pinned.state !== 'stored' || pinned.envelope.kind !== CHECKS_KIND.kind) return result('error', 'the pinned criteria are not stored', [])
      const checks = (pinned.envelope.content as Checks).checks
      const scratch = join(tmpdir(), `system-install-check-${request.attemptId.replace(/[^A-Za-z0-9-]/g, '-')}`)
      rmSync(scratch, { recursive: true, force: true })
      mkdirSync(scratch)
      const worktree = join(scratch, 'work')
      try {
        await addWorktree(tree.repository, worktree, tree.commit)
      } catch (error) {
        rmSync(scratch, { recursive: true, force: true })
        return result('error', `could not check out ${tree.commit}: ${(error as Error).message}`, [])
      }
      const evidence: string[] = []
      const failed: string[] = []
      try {
        for (const check of checks) {
          const started = now()
          const backstop = AbortSignal.timeout((check.timeoutSeconds + 20) * 1000)
          const spawned = spawner.spawn({
            argv: ['timeout', '-s', 'INT', '-k', '10', String(check.timeoutSeconds), '/bin/sh', '-c', check.run], cwd: worktree, signal: backstop, graceMs: 5000,
            env: { ...process.env, PATH: [bin, process.env.PATH].filter(Boolean).join(':') },
          })
          const outcome = await spawned.done
          const output = `${spawned.stdout()}\n${spawned.stderr()}`
          const timedOut = backstop.aborted || outcome.exitCode === 124
          const run = {
            name: check.name, run: check.run, commit: tree.commit, exitCode: outcome.exitCode, signal: outcome.signal, timedOut,
            durationMs: Math.max(0, Math.round(now() - started)), stdoutTail: tail(spawned.stdout()), stderrTail: tail(spawned.stderr()),
          }
          evidence.push((await artifacts.put({ ...CHECK_RUN_KIND, content: run, inputs: [request.subject, request.criteria], classification: 'local-private', producer })).id)
          if (timedOut) {
            const running = interrupted(output)
            failed.push(running.length ? `${check.name}: timed out after ${check.timeoutSeconds} s while running ${running.join(', ')}` : `${check.name} (timed out after ${check.timeoutSeconds} s)`)
          } else if (outcome.exitCode !== 0) {
            const first = firstFailure(output)
            failed.push(first ? `${check.name}: ${first}` : `${check.name} (exit ${outcome.exitCode ?? outcome.signal})`)
          }
        }
      } finally {
        await removeWorktree(tree.repository, worktree)
        rmSync(scratch, { recursive: true, force: true })
      }
      return failed.length
        ? result('fail', `failed: ${failed.join('; ')}`, evidence)
        : result('pass', `all ${checks.length} afterInstall check(s) passed on ${tree.commit}: ${checks.map((c) => c.name).join(', ')}`, evidence)
    },
  }
}
