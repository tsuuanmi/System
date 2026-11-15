import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** The Q0 rule (workflows/README.md): a Workflow pins only criteria versions that the previous release's verifiers know. */
export const Q0_REASON = 'the Q0 rule: a new criteria version is pinned in a Workflow only in a release after the one that added it, because `system update` checks a release with the running Host\'s verifiers'

/** Every `criteria:` value in a parsed Workflow document, with where it is. */
export function pinnedCriteria(doc: unknown): string[] {
  const found: string[] = []
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk)
    else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'criteria' && typeof value === 'string') found.push(value)
        else walk(value)
      }
    }
  }
  walk(doc)
  return found
}

/** The criteria names a verifiers source file knows: its quoted `<name>-v<N>` string literals. */
export function knownCriteria(source: string): Set<string> {
  return new Set([...source.matchAll(/(['"`])([a-z]+(?:-[a-z]+)*-v\d+)\1/g)].map((m) => m[2]!))
}

/** The problems of a comparison: each pin the previous release does not know, as one line naming the Workflow and the rule. */
export function unknownPins(pins: Record<string, string[]>, known: Set<string>): string[] {
  return Object.entries(pins).flatMap(([file, names]) => names.filter((n) => !known.has(n)).map((n) => `${file} pins ${n}, unknown to the previous release's verifiers; ${Q0_REASON}`))
}

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

/** The last release: `origin/main` when it exists (a local `main` can be stale), else `main`; undefined in a clone without either. */
function releaseRef(): string | undefined {
  for (const ref of ['origin/main', 'main']) {
    try {
      git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
      return ref
    } catch {}
  }
  return undefined
}

test('unknownPins names a pinned criteria that the previous release does not know', () => {
  const known = knownCriteria(`export const A = 'repo-checks-v1'\nconst B = "repo-checks-v2"\n// repo-checks-v3 is only a comment`)
  assert.deepEqual([...known].sort(), ['repo-checks-v1', 'repo-checks-v2'])
  const doc = parse('steps:\n  - id: a\n    verify:\n      criteria: repo-checks-v3\n  - id: b\n    verify:\n      criteria: repo-checks-v2\n')
  const problems = unknownPins({ 'workflows/demo.yaml': pinnedCriteria(doc) }, known)
  assert.equal(problems.length, 1)
  assert.match(problems[0]!, /workflows\/demo\.yaml pins repo-checks-v3/)
  assert.ok(problems[0]!.includes(Q0_REASON))
  assert.deepEqual(unknownPins({ 'w.yaml': ['repo-checks-v2'] }, known), [])
})

test('Workflows pin only criteria versions the last release knows (Q0 rule)', (t) => {
  const ref = releaseRef()
  if (ref === undefined) return t.skip('no main branch in this clone (shallow clone?): cannot read the last release')
  const files = ['workflows', 'workflows/experiments'].flatMap((dir) => readdirSync(join(repo, dir)).filter((f) => /\.ya?ml$/.test(f) && !f.endsWith('.patch.yml')).map((f) => `${dir}/${f}`))
  const pins: Record<string, string[]> = {}
  for (const file of files) pins[file] = pinnedCriteria(parse(readFileSync(join(repo, file), 'utf8')))
  const known = new Set<string>()
  for (const file of git('ls-tree', '--name-only', ref, 'packages/verifiers/src/').split('\n').filter((f) => f.endsWith('.ts'))) {
    for (const name of knownCriteria(git('show', `${ref}:${file}`))) known.add(name)
  }
  assert.deepEqual(unknownPins(pins, known), [], `criteria unknown to ${ref}`)
})

/** The Escaped defect 7 rule (Q0 generalised): a file the running Host reads at admission or update uses only keys the last release knows. */
export const KEYS_REASON = 'the Q0 rule (Escaped defect 7): a new key of `.system/checks.yaml` is used in this repository only in a release after the one that added it, because the running Host\'s strict schema refuses a key it does not know and so every new Work'

/** The string list a verifiers source declares as `export const <name> = [...]`; undefined when it has no such constant (a release before the constants existed). */
export function constantList(source: string, name: string): string[] | undefined {
  const m = source.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`))
  return m ? [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!) : undefined
}

/** The keys a release's checks.ts knows: its constants, or for a release before them the keys written in the schema. */
export function knownKeys(source: string): { file: Set<string>; check: Set<string> } {
  const fromSchema = (schema: string) => {
    const body = source.split(`const ${schema} = z.object({`)[1]?.split('}).strict()')[0] ?? ''
    return [...body.matchAll(/^ {2}(\w+): z\./gm)].map((m) => m[1]!)
  }
  return {
    file: new Set(constantList(source, 'CHECKS_FILE_KEYS') ?? fromSchema('checksFileSchema')),
    check: new Set(constantList(source, 'CHECK_KEYS') ?? fromSchema('checkSchema')),
  }
}

/** The problems of a checks file: each key (top-level or of a check) the last release does not know, as one line naming the key and the rule. */
export function unknownKeys(file: string, doc: unknown, known: { file: Set<string>; check: Set<string> }): string[] {
  if (doc === null || typeof doc !== 'object') return []
  const problems: string[] = []
  for (const [key, value] of Object.entries(doc)) {
    if (!known.file.has(key)) problems.push(`${file} uses the key ${key}, unknown to the previous release; ${KEYS_REASON}`)
    else if (Array.isArray(value)) {
      for (const check of value) {
        if (check === null || typeof check !== 'object') continue
        for (const k of Object.keys(check)) if (!known.check.has(k)) problems.push(`${file} uses the check key ${k} (in ${key}), unknown to the previous release; ${KEYS_REASON}`)
      }
    }
  }
  return problems
}

test('unknownKeys names a checks.yaml key that the last release does not know', () => {
  const main = `export const CHECKS_FILE_KEYS = ['checks'] as const\nexport const CHECK_KEYS = ['name', 'run'] as const\n`
  const known = knownKeys(main)
  const doc = parse('checks:\n  - name: a\n    run: x\nafterInstall:\n  - name: b\n    run: y\n')
  const problems = unknownKeys('.system/checks.yaml', doc, known)
  assert.equal(problems.length, 1)
  assert.match(problems[0]!, /\.system\/checks\.yaml uses the key afterInstall/)
  assert.ok(problems[0]!.includes(KEYS_REASON))
  assert.match(unknownKeys('c.yaml', parse('checks:\n  - name: a\n    run: x\n    paths: [a]\n'), known)[0]!, /check key paths/)
  assert.deepEqual(unknownKeys('c.yaml', parse('checks:\n  - name: a\n    run: x\n'), known), [])
})

test('knownKeys reads a release before the constants from its schema', () => {
  const src = `const checkSchema = z.object({\n  name: z.string(),\n  run: z.string(),\n}).strict()\nexport const checksFileSchema = z.object({\n  checks: z.array(checkSchema),\n}).strict()\n`
  const known = knownKeys(src)
  assert.deepEqual([...known.file], ['checks'])
  assert.deepEqual([...known.check], ['name', 'run'])
})

test('this repository\'s .system/checks.yaml uses only keys the last release knows (Escaped defect 7)', (t) => {
  const ref = releaseRef()
  if (ref === undefined) return t.skip('no main branch in this clone (shallow clone?): cannot read the last release')
  const known = knownKeys(git('show', `${ref}:packages/verifiers/src/checks.ts`))
  assert.deepEqual(unknownKeys('.system/checks.yaml', parse(readFileSync(join(repo, '.system/checks.yaml'), 'utf8')), known), [], `keys unknown to ${ref}`)
})

test('the schema and the exported key constants list the same keys', async () => {
  const { checksFileSchema, CHECKS_FILE_KEYS, CHECK_KEYS } = await import('../src/checks.ts')
  assert.deepEqual(Object.keys(checksFileSchema.shape).sort(), [...CHECKS_FILE_KEYS].sort())
  assert.deepEqual(Object.keys(checksFileSchema.shape.checks.element.shape).sort(), [...CHECK_KEYS].sort())
})
