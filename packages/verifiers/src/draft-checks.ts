/**
 * A DRAFT `.system/checks.yaml` from GitHub Actions workflows (`system bootstrap plan`, Item bs-3). Only a plain `run:` step is
 * translated; every other step is listed with the reason. The draft is text for a human to review, never a file System writes.
 */
import { parse, stringify } from 'yaml'
import { CHECKS_FILE, parseChecksFile } from './checks.ts'

interface WorkflowFile { name: string; text: string }
export interface DraftChecks {
  /** The draft file text; absent when no step could be translated or the draft fails the schema. */
  draft?: string
  /** `not translated: <workflow>/<job>/<step>: <why>`, in file order. */
  notTranslated: string[]
  /** `setup, not a check: <workflow>/<job>/<step>: <command>`: plain steps that only install or set up a tool, in file order. */
  setup: string[]
  /** Why there is no draft, or what is wrong with it. */
  note?: string
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const has = (v: unknown, re: RegExp): boolean => re.test(JSON.stringify(v) ?? '')

/** Why a step cannot be a plain check, or undefined when it can. */
function why(job: Obj, step: Obj): string | undefined {
  if (isObj(job.strategy) && 'matrix' in job.strategy) return 'the job has a matrix'
  if ('services' in job) return 'the job has services'
  if (typeof step.uses === 'string') return `uses ${step.uses}`
  if (typeof step.run !== 'string') return 'no run command'
  if (has(step, /secrets\./)) return 'it uses secrets'
  if (has(step, /\$\{\{/)) return 'it uses a ${{ }} expression'
  for (const key of ['if', 'env', 'working-directory', 'shell']) if (key in step) return `it sets ${key}`
  return undefined
}

const SETUP = [
  /^cargo install(\s|$)/, /^rustup (toolchain install|target add|component add)(\s|$)/,
  /^(python3? -m )?pip3? install(\s|$)/, /^pipx install(\s|$)/, /^apt(-get)? install(\s|$)/,
  /^npm (ci|install)(\s|$)/, /^pnpm install(\s|$)/, /^yarn install(\s|$)/, /^corepack enable(\s|$)/,
]
/** True when every command of the step (one per line or `&&` part) only installs or sets up a tool. */
function isSetup(run: string): boolean {
  const parts = run.split(/\r?\n|&&/).map((p) => p.trim().replace(/^sudo\s+/, '')).filter(Boolean)
  return parts.length > 0 && parts.every((p) => SETUP.some((re) => re.test(p)))
}

export function draftChecks(files: WorkflowFile[]): DraftChecks {
  const notTranslated: string[] = []
  const setup: string[] = []
  const checks: { name: string; run: string }[] = []
  const taken = new Set<string>()
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const workflow = file.name.replace(/\.ya?ml$/, '')
    let doc: unknown
    try { doc = parse(file.text) } catch (error) {
      notTranslated.push(`not translated: ${workflow}: not valid YAML: ${(error as Error).message.split('\n')[0]}`)
      continue
    }
    const jobs = isObj(doc) && isObj(doc.jobs) ? doc.jobs : {}
    for (const [jobId, job] of Object.entries(jobs)) {
      if (!isObj(job) || !Array.isArray(job.steps)) continue
      job.steps.forEach((raw: unknown, index: number) => {
        const step = isObj(raw) ? raw : {}
        const label = typeof step.name === 'string' ? step.name : typeof step.uses === 'string' ? step.uses : `step-${index + 1}`
        const reason = why(job, step)
        if (reason) { notTranslated.push(`not translated: ${workflow}/${jobId}/${label}: ${reason}`); return }
        if (isSetup(step.run as string)) {
          setup.push(`setup, not a check: ${workflow}/${jobId}/${label}: ${(step.run as string).trim().split(/\s*\r?\n\s*/).join('; ')}`)
          return
        }
        const base = slug(`${workflow}-${jobId}-${typeof step.name === 'string' ? step.name : `step-${index + 1}`}`).replace(/^[^a-z]+/, '') || 'check'
        let name = base
        for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
        taken.add(name)
        checks.push({ name, run: step.run as string })
      })
    }
  }
  if (checks.length === 0) return { notTranslated, setup, note: 'no plain run steps to translate: write .system/checks.yaml by hand' }
  const draft = stringify({ checks })
  const parsed = parseChecksFile(draft)
  if ('problem' in parsed) return { notTranslated, setup, note: `the draft does not pass the checks schema (${CHECKS_FILE}): ${parsed.problem}` }
  return { draft, notTranslated, setup }
}
