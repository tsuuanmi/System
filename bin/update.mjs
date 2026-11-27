// `system update`: switch the install to the newest commit of `main`, and only to code that
// passed its own required checks on this machine. Plain JavaScript that needs no build, like service.mjs.
//
// The install (`~/.system`): `release/`, a clone of the origin; `releases/<commit>/`, one worktree of it per
// commit, installed and built, never edited by hand; `current`, the link to the release the Host runs.
// The steps, each stopping the update when it fails, with `current` left where it was:
//   1. fetch `main`; the commit already current is nothing to do;
//   2. add its release and build it (`pnpm install --frozen-lockfile`, `pnpm build`);
//   3. check it by a System Work: `workflows/code-checks.yaml` on a task whose base is that commit, so
//      the evidence is a Work bound to the exact commit (the Host's `code.required-checks`). With a
//      `current`, the commit is a change from it (`task new --against`, the base's `parent`): the
//      verifier runs the checks `paths` selects for the files that differ between the two releases, from
//      the new commit's own `.system/checks.yaml`; the first install checks the whole commit. As the event `release` (a check's
//      `on:`, Item ct-1) when the running release's verifiers know `repo-checks-release-v1`, else as `pull_request`;
//   4. switch `current` (a new link renamed over it, so the switch is atomic);
//   5. ask the Host, as a client of the new code, until it runs it: a hello of other code makes a Host
//      whose `current` changed drain and exit 75, and the unit starts the new code (D). If it does not
//      come up in time, switch `current` back; the unit's next start runs the code before.
//   6. verify it on the install (Item fl-5): when the commit's `.system/checks.yaml` lists `afterInstall` checks, run them
//      as a Work of the verifier `release.install-check` (the Host runs the new code, so it knows the verifier; its workflow
//      is written here, not pinned by a file of the repository, the Q0 rule), bound to the commit. A failed check switches
//      `current` back and the Host is asked to run the release before; the failed check is named.
// The releases other than the current one and the one before are removed.
// `system update --to <release>` (Item revert-1) is the way back: it switches `current` to a kept release through steps 4-6 only.
import { dirname, join } from 'node:path'

/** The Work of the install check: a verify step of `release.install-check`, its input the release commit's task. */
const INSTALL_CHECK_WORKFLOW = `# Written by \`system update\` (Item fl-5); not a file of the repository, so no Workflow pins the verifier (Q0).
schema: system.workflow/v1
id: install-check
version: 1
steps:
  - id: install
    verify:
      capability: release.install-check
      subject: $work.input
      criteria: install-check-v1
`

/**
 * The Work of the release check when the running Host knows the criteria `repo-checks-release-v1` (Item ct-1): the checks that name
 * `on: [release]` run, and those that name only other events do not. Written here, not a file of the repository, so no Workflow pins
 * the new criteria before the running release knows it (the Q0 rule); an older running Host gets `code-checks.yaml`, as before.
 */
const RELEASE_CHECK_WORKFLOW = `# Written by \`system update\` (Item ct-1); not a file of the repository, so no Workflow pins the criteria (Q0).
schema: system.workflow/v1
id: release-check
version: 1
steps:
  - id: checks
    verify:
      capability: code.required-checks
      subject: $work.input
      criteria: repo-checks-release-v1
`

/** The record a switch leaves while its afterInstall check has no passed verdict (Item upd-1). */
export const PENDING = 'pending-install-check.json'

const DEFAULT_WAIT_MS = 75 * 60_000
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'held'])

/**
 * Wait for `workId` by polling `work show` until it reaches a terminal state (`succeeded`, `failed`, `cancelled`, `held`)
 * or `waitMs` elapses. Fails closed (no terminal status, with `error`) when the Work cannot be read or times out.
 */
async function waitForWork({ show, workId, sleep, now, waitMs }) {
  const until = now() + waitMs
  for (;;) {
    const shown = await show()
    if (shown.status !== 0) {
      return { status: undefined, stdout: shown.stdout, error: `cannot read ${workId}: status ${shown.status}` }
    }
    let record
    try {
      record = JSON.parse(shown.stdout)
    } catch {
      return { status: undefined, stdout: shown.stdout, error: `cannot read ${workId}: invalid JSON` }
    }
    const status = record?.state?.status
    if (typeof status !== 'string') {
      return { status: undefined, stdout: shown.stdout, error: `cannot read ${workId}: missing state.status` }
    }
    if (TERMINAL.has(status)) {
      return { status, stdout: shown.stdout, reason: typeof record.state.reason === 'string' ? record.state.reason : undefined }
    }
    if (now() >= until) {
      return { status: undefined, stdout: shown.stdout, error: `timed out waiting for ${workId} (${status})` }
    }
    await sleep(5000)
  }
}

/**
 * Complete the install check the record names: submit the install-check Work with the NEW release's client (the Host runs it, and
 * refuses an older client), remove the record on a pass, and on a failure switch `current` back to the release before and remove it
 * (the Host then upgrades to that code). Called by `system update` once the Host runs the release, and by the Host that starts on it
 * when the update was killed (`system update --finish-pending`). Resolves whether the check passed (true when no record).
 */
export async function finishInstallCheck({ install, run, read, write, remove, switchLink, log, sleep = defaultSleep, now = Date.now, waitMs = DEFAULT_WAIT_MS }) {
  const text = read(join(install, PENDING))
  if (!text) return true
  const { commit, previous, task, workflow } = JSON.parse(text)
  const newCli = join(install, 'releases', commit, 'bin', 'system')
  // The workflow file is written by the update; a killed one may not have left it intact, so write it again.
  write(workflow, INSTALL_CHECK_WORKFLOW)
  log(`verifying the install of ${commit.slice(0, 12)} with its afterInstall checks, as a System Work`)
  const installed = await run(process.execPath, [newCli, 'work', 'submit', '--workflow', workflow, '--input', task])
  const installWork = installed.stdout.split('\n').find((line) => line.startsWith('work:'))?.trim()
  if (!installWork) {
    const reason = lastLine(installed.stdout) || 'no Work ID printed'
    switchLink(join(install, 'current'), previous)
    remove(join(install, PENDING))
    log(`the install checks of ${commit.slice(0, 12)} failed (no Work ID printed): ${reason}; switched back to ${previous}, asking the Host to run it`)
    return false
  }
  const result = await waitForWork({ show: () => run(process.execPath, [newCli, 'work', 'show', installWork]), workId: installWork, sleep, now, waitMs })
  if (result.status !== 'succeeded') {
    const reason = result.error ?? result.reason ?? (/"reason":\s*"((?:[^"\\]|\\.)*)"/.exec(result.stdout)?.[1] ?? (lastLine(result.stdout) || result.status))
    switchLink(join(install, 'current'), previous)
    remove(join(install, PENDING))
    log(`the install checks of ${commit.slice(0, 12)} failed (${installWork}): ${reason}; switched back to ${previous}, asking the Host to run it`)
    return false
  }
  remove(join(install, PENDING))
  log(`the install checks of ${commit.slice(0, 12)} passed: ${installWork}`)
  return true
}

/**
 * `system update --finish-pending`, run by a Host that started on `commit` (its own release): complete the pending install check
 * when the record is for that commit and the `system update` that wrote it is gone (a live one completes it itself).
 */
export async function finishPending({ install, commit, alive, ...deps }) {
  const text = deps.read(join(install, PENDING))
  if (!text) return 0
  const record = JSON.parse(text)
  if (record.commit !== commit) return 0
  if (record.updatePid && alive(record.updatePid)) return 0
  return (await finishInstallCheck({ install, ...deps })) ? 0 : 1
}

/** The last line of a command's output. */
const lastLine = (text) => text.trim().split('\n').at(-1) ?? ''

/**
 * `system update --to <release>` (Item revert-1): switch `current` to a release kept in `releases/` (the one before, normally) through
 * the same switch, drain and afterInstall check as an update; no fetch, build or release check, the kept release passed them when it
 * was installed. A release not in `releases/` is refused and nothing changes. A failed afterInstall check, or a Host that does not come
 * up, switches back to the release the revert left. `to` is a commit or a unique prefix of one.
 */
async function revert({ install, to, cli, run, write, read, remove, readlink, switchLink, releases, probe, sleep, now, log, waitMs }) {
  const repo = join(install, 'source')
  const link = join(install, 'current')
  const kept = releases().filter((name) => name === to || (to.length >= 7 && name.startsWith(to)))
  const exact = kept.find((name) => name === to)
  const commit = exact ?? (kept.length === 1 ? kept[0] : undefined)
  if (!commit) {
    log(`${to} is ${kept.length > 1 ? 'ambiguous' : 'not in releases/'} (kept: ${releases().join(', ') || 'none'}); current stays ${readlink(link) ?? 'unset'}`)
    return 1
  }
  const before = readlink(link)
  if (before === `releases/${commit}`) {
    log(`${commit.slice(0, 12)} is already current`)
    return 0
  }
  const release = join(install, 'releases', commit)
  try {
    const listed = (await run('git', ['-C', repo, 'show', `${commit}:.system/checks.yaml`])).stdout
    const pending = /^afterInstall:/m.test(listed) && before !== undefined
    let task
    if (pending) {
      const made = await run(cli, ['task', 'new', '--text', `Revert check of ${commit} for the install`, '--repo', repo, '--ref', commit])
      if (made.status !== 0) throw new Error(`system task new failed with status ${made.status}`)
      task = made.stdout.trim()
      write(join(install, 'install-check.yaml'), INSTALL_CHECK_WORKFLOW)
      write(join(install, PENDING), JSON.stringify({ commit, previous: before, task, workflow: join(install, 'install-check.yaml'), updatePid: process.pid }, null, 2))
    }
    switchLink(link, `releases/${commit}`)
    log(`reverted: current is ${commit.slice(0, 12)}; waiting for the Host to drain and start it`)
    if (before === undefined) return 0
    const until = now() + waitMs
    for (;;) {
      if (await probe(release)) break
      if (now() >= until) {
        switchLink(link, before)
        remove(join(install, PENDING))
        log(`the Host did not come up on ${commit.slice(0, 12)} within ${Math.round(waitMs / 60_000)} min; switched back to ${before}`)
        return 1
      }
      await sleep(5000)
    }
    log(`the Host runs ${commit.slice(0, 12)}`)
    if (pending && !(await finishInstallCheck({ install, run, read, write, remove, switchLink, log, sleep, now, waitMs }))) {
      const back = now() + waitMs
      while (!(await probe(join(install, before))) && now() < back) await sleep(5000)
      return 1
    }
    return 0
  } catch (error) {
    log(`${error.message}; current stays where it was`)
    return 1
  }
}

export async function update({ to, ...deps }) {
  if (to !== undefined) return revert({ to, ...deps })
  return upgrade(deps)
}

async function upgrade({ install, cli, origin, run, write, read, remove, exists, readlink, switchLink, releases, probe, sleep, now, log, waitMs }) {
  const repo = join(install, 'source')
  const link = join(install, 'current')
  // corepack beside the Node running this (Item ns-2); its `pnpm` shim finds `node` on the PATH `run` is given, which starts with that Node's directory.
  const corepack = join(dirname(process.execPath), 'corepack')
  const git = (...args) => run('git', ['-C', repo, ...args])
  const must = async (what, ran) => {
    const result = await ran
    if (result.status !== 0) throw new Error(`${what} failed with status ${result.status}`)
    return result.stdout
  }
  try {
    if (!exists(repo)) await must('git clone', run('git', ['clone', '--no-checkout', origin, repo]))
    await must('git fetch', git('fetch', '--quiet', 'origin', 'main'))
    const commit = lastLine(await must('git rev-parse', git('rev-parse', 'FETCH_HEAD')))
    const before = readlink(link)
    if (before === `releases/${commit}`) {
      log(`${commit.slice(0, 12)} is already current`)
      return 0
    }
    const release = join(install, 'releases', commit)
    if (!exists(release)) await must('git worktree add', git('worktree', 'add', '--detach', release, commit))
    log(`building ${commit.slice(0, 12)} in ${release}`)
    await must('pnpm install', run(corepack, ['pnpm', 'install', '--frozen-lockfile'], release))
    await must('pnpm build', run(corepack, ['pnpm', 'build'], release))

    // The commit `current` points to, when it is a release of this install; the new commit is checked as a change from it.
    const running = before?.startsWith('releases/') ? before.slice('releases/'.length) : undefined
    log(`checking ${commit.slice(0, 12)} with its required checks, as a System Work${running ? `, as a change from the running release ${running.slice(0, 12)}` : ' (the first install: the whole commit)'}`)
    const task = (await must('system task new', run(cli, ['task', 'new', '--text', `Release check of ${commit} for the install`, '--repo', repo, '--ref', commit, ...(running ? ['--against', running] : [])]))).trim()
    // The release event (ct-1) only when the Host that runs now knows its criteria: its checks.ts names it.
    const knowsRelease = running !== undefined && (read(join(install, 'releases', running, 'packages', 'verifiers', 'src', 'checks.ts')) ?? '').includes('repo-checks-release-v1')
    if (knowsRelease) write(join(install, 'release-check.yaml'), RELEASE_CHECK_WORKFLOW)
    const checked = await run(cli, ['work', 'submit', '--workflow', knowsRelease ? join(install, 'release-check.yaml') : join(release, 'workflows', 'code-checks.yaml'), '--input', task])
    const work = checked.stdout.split('\n').find((line) => line.startsWith('work:'))?.trim()
    if (!work) {
      const compared = running ? `compared with ${running.slice(0, 12)}; skipped: none` : 'whole commit, none skipped'
      log(`the checks of ${commit.slice(0, 12)} failed (no Work ID printed; ${compared}); current stays ${before ?? 'unset'}`)
      return 1
    }
    const result = await waitForWork({ show: () => run(cli, ['work', 'show', work]), workId: work, sleep, now, waitMs })
    // The verdict names the checks it skipped; the Work record carries it.
    const skipped = /skipped: ([\w.-]+(?:, [\w.-]+)*)/.exec(result.stdout)?.[1]
    const compared = running ? `compared with ${running.slice(0, 12)}; skipped: ${skipped ?? 'none'}` : 'whole commit, none skipped'
    if (result.status !== 'succeeded') {
      log(`the checks of ${commit.slice(0, 12)} failed (${work}${result.error ? `: ${result.error}` : ''}; ${compared}); current stays ${before ?? 'unset'}`)
      return 1
    }
    log(`the checks of ${commit.slice(0, 12)} passed: ${work} (${compared})`)

    // The afterInstall checks of this commit, run against the installed release (not the checkout). When there are any, the switch
    // leaves a record (Item upd-1): a killed update, or a Host that restarts, still finds the check to complete.
    const listed = (await git('show', `${commit}:.system/checks.yaml`)).stdout
    const pending = /^afterInstall:/m.test(listed) && before !== undefined
    if (pending) {
      write(join(install, 'install-check.yaml'), INSTALL_CHECK_WORKFLOW)
      write(join(install, PENDING), JSON.stringify({ commit, previous: before, task, releaseCheck: work, workflow: join(install, 'install-check.yaml'), updatePid: process.pid }, null, 2))
    }
    switchLink(link, `releases/${commit}`)
    if (!before) {
      log(`current is ${commit.slice(0, 12)}, the first install: link \`${join(link, 'bin', 'system')}\` as \`system\` on PATH, run \`system init\` and \`systemctl --user enable --now system\` (docs/operations/install-and-update.md, "Install and start")`)
      return 0
    }
    log(`current is ${commit.slice(0, 12)}; waiting for the Host to drain and start it`)
    const until = now() + waitMs
    for (;;) {
      if (await probe(release)) break
      if (now() >= until) {
        switchLink(link, before)
        remove(join(install, PENDING))
        log(`the Host did not come up on ${commit.slice(0, 12)} within ${Math.round(waitMs / 60_000)} min; switched back to ${before}`)
        return 1
      }
      await sleep(5000)
    }
    log(`the Host runs ${commit.slice(0, 12)}`)

    if (pending) {
      if (!(await finishInstallCheck({ install, run, read, write, remove, switchLink, log, sleep, now, waitMs }))) {
        const back = now() + waitMs
        while (!(await probe(join(install, before))) && now() < back) await sleep(5000)
        return 1
      }
    }
    for (const old of releases()) {
      if (`releases/${old}` === before || old === commit) continue
      await git('worktree', 'remove', '--force', join(install, 'releases', old))
    }
    return 0
  } catch (error) {
    log(`${error.message}; current stays where it was`)
    return 1
  }
}
