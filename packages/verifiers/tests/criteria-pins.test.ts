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
