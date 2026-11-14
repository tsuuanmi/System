/**
 * `system bootstrap plan --repo <path>` (Item bs-3): everything a human needs to make a repository ready for System, printed.
 * It writes no file and creates no branch or commit: the draft and the commands are text. It reuses `bootstrapCheck` (bs-2)
 * and `tools/bootstrap_docs.py --plan` (bs-1, of the running release) and runs nothing else of the target.
 */
import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { git } from '@system/work'
// By path, as bootstrap.ts does.
import { CHECKS_FILE } from '../../verifiers/lib/checks.js'
import { draftChecks, type DraftChecks } from '../../verifiers/lib/draft-checks.js'
import { bootstrapCheck, formatBootstrap } from './bootstrap.ts'

/** The System checkout or release this file runs from (`packages/app/{src,lib}`). */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export interface BootstrapPlan extends DraftChecks {
  text: string
}

const shell = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

export async function bootstrapPlan(path: string): Promise<BootstrapPlan> {
  const top = realpathSync((await git(path, ['rev-parse', '--show-toplevel'])).trim())
  const files = await promisify(execFile)('python3', [join(ROOT, 'tools', 'bootstrap_docs.py'), '--out', top, '--name', basename(top), '--plan'], { maxBuffer: 1 << 20 })
    .then((r) => r.stdout, (e: Error) => `could not run bootstrap_docs.py --plan: ${e.message}\n`)
  const results = formatBootstrap(await bootstrapCheck(top))

  const dir = join(top, '.github', 'workflows')
  const workflows = (() => { try { return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') })) } catch { return [] } })()
  const draft = draftChecks(workflows)

  const repo = shell(top)
  const draftText = draft.draft ?? `(no draft: ${draft.note ?? 'nothing to translate'})\n`
  const skipped = draft.notTranslated.length ? draft.notTranslated.join('\n') + '\n' : ''
  const commands = [
    '# 1. Create dev from main (ask the owner first; skip if dev already exists):',
    `git -C ${repo} branch dev main`,
    `git -C ${repo} switch dev`,
    `# 2. Review the draft above, save it as ${CHECKS_FILE}, and commit it directly on dev:`,
    `git -C ${repo} add ${CHECKS_FILE}`,
    `git -C ${repo} commit -m ${shell('Add System checks')}`,
    '# 3. Push:',
    `git -C ${repo} push -u origin dev`,
    '# 4. Check the result:',
    `system bootstrap check --repo ${repo}`,
  ].join('\n') + '\n'
  const text = `== files ==\n${files}\n== checks ==\n${results}\n== draft ${CHECKS_FILE} ==\n${draftText}${skipped}\n== commands ==\n${commands}`
  return { ...draft, text }
}
