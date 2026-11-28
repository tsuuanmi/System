/**
 * sch-6 Guardrail (ADR-0020 decisions 1, 7): the model caller, its launcher, its units and its
 * shell copy of the layer are deleted, and the retired name leaves every tracked path and every
 * file under packages/, bin/, tests/, tools/ and docs/operations/.
 *
 * Recorded historical fixtures under tests/fixtures/ (real logs from past runs) and the exact
 * old unit name in docs/operations/scheduled-session.md (for the operator's removal steps) are
 * the only exceptions.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const RETIRED = ['ni', 'ght'].join('')
const RETIRED_RE = new RegExp(RETIRED, 'i')
const OLD_UNIT_RE = new RegExp(`system-${RETIRED}-session`, 'gi')
const SCOPES = ['packages/', 'bin/', 'tests/', 'tools/', 'docs/operations/']
const REMOVAL_DOC = 'docs/operations/scheduled-session.md'

function repoFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: repo,
    encoding: 'utf8',
  })
  return [...new Set(listed.split('\n').filter((p) => p.length > 0 && existsSync(join(repo, p))))].sort()
}

test('no tracked path contains the retired name', () => {
  const hits = repoFiles().filter((path) => RETIRED_RE.test(path))
  assert.deepEqual(hits, [], `paths still containing the retired name:\n${hits.join('\n')}`)
})

test('no file under packages/, bin/, tests/, tools/ or docs/operations/ contains the retired name', () => {
  const hits: string[] = []
  for (const path of repoFiles()) {
    if (!SCOPES.some((prefix) => path.startsWith(prefix))) continue
    if (/\/tests\/fixtures\//.test(path)) continue
    let content = readFileSync(join(repo, path), 'utf8')
    if (path === REMOVAL_DOC) content = content.replace(OLD_UNIT_RE, '')
    if (RETIRED_RE.test(content)) hits.push(path)
  }
  assert.deepEqual(hits, [], `files still containing the retired name:\n${hits.join('\n')}`)
})
