/** The afterInstall check `workers` (.system/checks.yaml) accepts the `system workers` output, which ends with a `room:` line (Item st-1). */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
const repo = new URL('../../../', import.meta.url).pathname

// The `run: |` block of the check, read without a YAML parser: the lines indented deeper than `run:` that follow it.
function checkScript(): string {
  const lines = readFileSync(join(repo, '.system', 'checks.yaml'), 'utf8').split('\n')
  const at = lines.findIndex((l) => l === '  - name: workers')
  const start = lines.findIndex((l, i) => i > at && l === '    run: |')
  assert.ok(at >= 0 && start > at, 'the workers check is in checks.yaml')
  const body: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (!l.startsWith('      ')) break
    body.push(l.slice(6))
  }
  return body.join('\n')
}
const script = checkScript()

function run(output: string) {
  const dir = mkdtempSync('/tmp/sm-wc-')
  writeFileSync(join(dir, 'system'), `#!/bin/sh\ncat <<'EOF2'\n${output}\nEOF2\n`)
  chmodSync(join(dir, 'system'), 0o755)
  return spawnSync('bash', ['-c', script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8' }).status
}

const accounts = 'registered: 1\nacct-a\n  abilities: x\nacct-b\n  abilities: y'
test('the workers check accepts output ending with a room line', () => {
  assert.equal(run(`${accounts}\nroom: 3 Accounts free, 1 busy`), 0)
})
test('the workers check still rejects an account without abilities', () => {
  assert.equal(run('registered: 2\nacct-a\n  abilities: x\nacct-b\nroom: 1 Accounts free'), 1)
  assert.equal(run('registered: 0\nroom: 0 Accounts free'), 1)
})
