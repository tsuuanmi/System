// `system update` (PLAN DF0b): switch the install to the newest commit of `main`, and only to code that
// passed its own required checks on this machine. Plain JavaScript that needs no build, like service.mjs.
//
// The install (`~/.system`): `repo/`, a clone of the origin; `releases/<commit>/`, one worktree of it per
// commit, installed and built, never edited by hand; `current`, the link to the release the Host runs.
// The steps, each stopping the update when it fails, with `current` left where it was:
//   1. fetch `main`; the commit already current is nothing to do;
//   2. add its release and build it (`pnpm install --frozen-lockfile`, `pnpm build`);
//   3. check it by a System Work: `workflows/code-checks.yaml` on a task whose base is that commit, so
//      the evidence is a Work bound to the exact commit (the Host's `code.required-checks`);
//   4. switch `current` (a new link renamed over it, so the switch is atomic);
//   5. ask the Host, as a client of the new code, until it runs it: a hello of other code makes a Host
//      whose `current` changed drain and exit 75, and the unit starts the new code (D). If it does not
//      come up in time, switch `current` back; the unit's next start runs the code before.
// The releases other than the current one and the one before are removed.
import { join } from 'node:path'

/** The last line of a command's output. */
const lastLine = (text) => text.trim().split('\n').at(-1) ?? ''

export async function update({ install, cli, origin, run, exists, readlink, switchLink, releases, probe, sleep, now, log, waitMs }) {
  const repo = join(install, 'repo')
  const link = join(install, 'current')
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
    await must('pnpm install', run('corepack', ['pnpm', 'install', '--frozen-lockfile'], release))
    await must('pnpm build', run('corepack', ['pnpm', 'build'], release))

    log(`checking ${commit.slice(0, 12)} with its required checks, as a System Work`)
    const task = lastLine(await must('system task new', run(cli, ['task', 'new', '--text', `Release check of ${commit} for the install`, '--repo', repo, '--ref', commit])))
    const checked = await run(cli, ['work', 'submit', '--workflow', join(release, 'workflows', 'code-checks.yaml'), '--input', task])
    const work = checked.stdout.split('\n').find((line) => line.startsWith('work:')) ?? '(no Work ID printed)'
    if (checked.status !== 0) {
      log(`the checks of ${commit.slice(0, 12)} failed (${work}); current stays ${before ?? 'unset'}`)
      return 1
    }
    log(`the checks of ${commit.slice(0, 12)} passed: ${work}`)

    switchLink(link, `releases/${commit}`)
    if (!before) {
      log(`current is ${commit.slice(0, 12)}, the first install: link \`${join(link, 'bin', 'system')}\` as \`system\` on PATH, run \`system init\` and \`systemctl --user enable --now system\` (runbook, "Install and start")`)
      return 0
    }
    log(`current is ${commit.slice(0, 12)}; waiting for the Host to drain and start it`)
    const until = now() + waitMs
    for (;;) {
      if (await probe(release)) break
      if (now() >= until) {
        switchLink(link, before)
        log(`the Host did not come up on ${commit.slice(0, 12)} within ${Math.round(waitMs / 60_000)} min; switched back to ${before}`)
        return 1
      }
      await sleep(5000)
    }
    log(`the Host runs ${commit.slice(0, 12)}`)
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
