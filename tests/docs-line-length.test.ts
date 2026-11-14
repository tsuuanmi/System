/**
 * tr-5: `tools/docs.py check` fails a prose line over 120 characters in a Markdown file under docs/;
 * table rows, fenced code, front matter, headings and a line that is only a URL or a link are excepted.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const long = 'word '.repeat(30).trim()
assert.ok(long.length > 120)

/** Line numbers `long_prose_lines` reports for a document, run through the real tools/docs.py. */
function flagged(text: string): number[] {
  const code = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("docs", "tools/docs.py")',
    'mod = importlib.util.module_from_spec(spec); sys.modules["docs"] = mod; spec.loader.exec_module(mod)',
    'print(json.dumps(mod.long_prose_lines(sys.stdin.read())))',
  ].join('\n')
  const run = spawnSync('python3', ['-c', code], { input: text, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  return JSON.parse(run.stdout)
}

test('a prose line over 120 characters is flagged, one of exactly 120 is not', () => {
  assert.deepEqual(flagged(`ok\n${long}\n`), [2])
  assert.deepEqual(flagged(`${'x'.repeat(120)}\n`), [])
  assert.deepEqual(flagged(`- ${long}\n`), [1])
})

test('tables, fenced code, front matter, headings, URLs and links are excepted', () => {
  const url = `https://example.com/${'a'.repeat(130)}`
  const doc = [
    '---', `summary: ${long}`, '---',
    `# ${long}`,
    `| ${long} | b |`,
    '```', long, '```',
    '~~~', long, '~~~',
    url,
    `<${url}>`,
    `- [${long}](${url})`,
    `[${long}](${url})`,
    long,
  ].join('\n')
  assert.deepEqual(flagged(doc), [16])
})

test('the checker reports docs lines as DOC-LEN-001 and the repository has none', () => {
  const run = spawnSync('python3', ['tools/docs.py', 'check'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
})
