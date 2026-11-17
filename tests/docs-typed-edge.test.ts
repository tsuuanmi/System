/**
 * `tools/docs.py check` fails a document under docs/ that has no typed edge (implements, decided-by, covers, verified-by,
 * supersedes, evidence, related) in its front matter. README.md routers and the retired-document ledger are excepted.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const skip = new Set(['node_modules', '.git', 'dist', '.building'])

/** Files git does not ignore: build output (such as packages/web-driver/lib) must not count as source in the copy. */
function kept(): Set<string> | undefined {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  return listed.status === 0 ? new Set(listed.stdout.split('\n').filter(Boolean)) : undefined
}

function check(mutate: (root: string) => void): { status: number | null; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), 'docs-edge-'))
  try {
    const files = kept()
    cpSync('.', root, {
      recursive: true,
      filter: (src) => {
        if (skip.has(src.split('/').pop() ?? '')) return false
        if (!files || src === '.') return true
        if (!statSync(src).isDirectory()) return files.has(src)
        return [...files].some((file) => file.startsWith(`${src}/`))
      },
    })
    mutate(root)
    const run = spawnSync('python3', ['tools/docs.py', 'check'], { cwd: root, encoding: 'utf8' })
    return { status: run.status, stderr: run.stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('the repository passes: every document has a typed edge', () => {
  assert.equal(check(() => {}).status, 0)
})

test('a document without a typed edge fails, naming it', () => {
  const run = check((root) => {
    writeFileSync(join(root, 'docs/architecture/orphan-edge.md'),
      '---\ntype: architecture\nsummary: No edge.\n---\n\n# No edge\n\nText.\n')
    const router = join(root, 'docs/architecture/README.md')
    writeFileSync(router, `${readFileSync(router, 'utf8')}\n- [orphan](orphan-edge.md)\n`)
  })
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /DOC-GRF-001 docs\/architecture\/orphan-edge\.md: no typed edge/)
})

test('a document with a related edge passes', () => {
  const run = check((root) => {
    writeFileSync(join(root, 'docs/architecture/orphan-edge.md'),
      '---\ntype: architecture\nsummary: Has an edge.\nrelated: [architecture/host]\n---\n\n# Edge\n\nText.\n')
    const router = join(root, 'docs/architecture/README.md')
    writeFileSync(router, `${readFileSync(router, 'utf8')}\n- [orphan](orphan-edge.md)\n`)
  })
  assert.equal(run.status, 0, run.stderr)
})
