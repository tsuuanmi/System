import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const fromRoot = createRequire(new URL('../../../package.json', import.meta.url))
const fromDsh = createRequire(fromRoot.resolve('@deepseek-ai/dsh/package.json'))
const presetPkgPath = fromDsh.resolve('@deepseek-ai/dsh-agent-preset/package.json')
const presetDir = path.dirname(presetPkgPath)
const srcSkillDir = path.join(presetDir, 'skills', 'dsh-doc')
const dstSkillDir = path.join(repoRoot, '.claude', 'skills', 'dsh-doc')
const refreshHint =
  'Refresh the copy from node_modules/@deepseek-ai/dsh-agent-preset/skills/dsh-doc/ to .claude/skills/dsh-doc/ (keeping NOTICE).'

function listFiles(dir: string, prefix = ''): string[] {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  const files: string[] = []
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listFiles(full, rel))
    } else if (entry.isFile()) {
      files.push(rel)
    }
  }
  return files
}

test('installed @deepseek-ai/dsh-agent-preset version matches packages/bundle/package.json engines.dsh', () => {
  const presetPkg = JSON.parse(readFileSync(presetPkgPath, 'utf8')) as { version?: string }
  const bundlePkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { engines?: { dsh?: string } }
  const installed = presetPkg.version
  const pinned = bundlePkg.engines?.dsh
  assert.equal(
    installed,
    pinned,
    `Installed @deepseek-ai/dsh-agent-preset (${installed}) does not match packages/bundle/package.json engines.dsh (${pinned}). ${refreshHint}`,
  )
})

test('.claude/skills/dsh-doc/ is a byte-for-byte copy of @deepseek-ai/dsh-agent-preset/skills/dsh-doc/ with NOTICE only', () => {
  assert.ok(
    existsSync(dstSkillDir),
    `Missing .claude/skills/dsh-doc/. ${refreshHint}`,
  )

  const srcFiles = listFiles(srcSkillDir)
  const dstFiles = listFiles(dstSkillDir)
  const srcSet = new Set(srcFiles)

  const extra = dstFiles.filter((file) => file !== 'NOTICE' && !srcSet.has(file))
  assert.deepEqual(
    extra,
    [],
    `Extra file(s) in .claude/skills/dsh-doc/: ${extra.join(', ')}. ${refreshHint}`,
  )

  assert.ok(
    dstFiles.includes('NOTICE'),
    `Missing .claude/skills/dsh-doc/NOTICE. ${refreshHint}`,
  )

  for (const rel of srcFiles) {
    const srcPath = path.join(srcSkillDir, rel)
    const dstPath = path.join(dstSkillDir, rel)
    assert.ok(
      existsSync(dstPath),
      `Missing file in .claude/skills/dsh-doc/: ${rel}. ${refreshHint}`,
    )
    const srcBytes = readFileSync(srcPath)
    const dstBytes = readFileSync(dstPath)
    assert.equal(
      Buffer.compare(srcBytes, dstBytes),
      0,
      `File differs from @deepseek-ai/dsh-agent-preset/skills/dsh-doc/: ${rel}. ${refreshHint}`,
    )
  }
})
