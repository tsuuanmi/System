/** ss-9: the launcher stores and sends the night report; run with a fake `claude` and a fake `system` on PATH. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
const repo = join(import.meta.dirname, '..', '..', '..')
const launcher = join(repo, 'packages', 'bundle', 'system-night-session.sh')

/** Runs the launcher with fakes; returns its result and what the fakes saw. */
function run(opts: { answer?: string; claudeExit?: number; putExit?: number; env?: Record<string, string> }) {
  const dir = mkdtempSync(join(tmpdir(), 'night-launcher-'))
  try {
    const exe = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
      chmodSync(join(dir, name), 0o755)
    }
    writeFileSync(join(dir, 'answer'), opts.answer ?? '')
    exe('claude', `printf '%s\\n' "$@" > "${dir}/claude.args"\ncat "${dir}/answer"\nexit ${opts.claudeExit ?? 0}`)
    exe('system', `printf '%s\\n' "$@" > "${dir}/system.args"\ncp "$3" "${dir}/stored" 2>/dev/null\n[ ${opts.putExit ?? 0} -eq 0 ] || { echo "put failed" >&2; exit ${opts.putExit ?? 0}; }\necho sha256:fakeid`)
    exe('notify', `printf '%s\\n' "$1" > "${dir}/notify.arg"`)
    exe('curl', `printf '%s\\n' "$@" > "${dir}/curl.args"`)
    const env = { PATH: `${dir}:${process.env.PATH}`, HOME: dir, ...opts.env }
    const res = spawnSync('sh', [launcher], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', cwd: dir })
    const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : undefined)
    return { res, dir, claudeArgs: read('claude.args'), systemArgs: read('system.args'), stored: read('stored'), notify: read('notify.arg'), curl: read('curl.args') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the answer is stored as markdown, its ID printed last, and claude asked for plain text', () => {
  const r = run({ answer: '# Night report\n\n- `x` and $HOME\n' })
  assert.equal(r.res.status, 0, r.res.stderr)
  assert.equal(r.stored, '# Night report\n\n- `x` and $HOME\n')
  assert.match(r.systemArgs!, /^artifact\nput\n.+\n--media-type\ntext\/markdown\n$/)
  assert.equal(r.res.stdout.trimEnd().split('\n').at(-1), 'sha256:fakeid')
  assert.match(r.claudeArgs!, /^-p\n/)
  assert.match(r.claudeArgs!, /--output-format\ntext\n/)
  assert.doesNotMatch(r.claudeArgs!, /artifact_put|NOTIFY/)
})

test('without a notifier nothing is sent', () => {
  const r = run({ answer: 'report' })
  assert.equal(r.curl, undefined)
  assert.equal(r.notify, undefined)
})

test('SYSTEM_NIGHT_NOTIFY_URL gets the ID as the POST body', () => {
  const r = run({ answer: 'report', env: { SYSTEM_NIGHT_NOTIFY_URL: 'http://ntfy.invalid/topic' } })
  assert.equal(r.res.status, 0, r.res.stderr)
  assert.match(r.curl!, /-d\nsha256:fakeid\nhttp:\/\/ntfy\.invalid\/topic\n$/)
})

test('SYSTEM_NIGHT_NOTIFY_COMMAND gets the ID as $1', () => {
  const r = run({ answer: 'report', env: { SYSTEM_NIGHT_NOTIFY_COMMAND: 'notify "$@"' } })
  assert.equal(r.res.status, 0, r.res.stderr)
  assert.equal(r.notify, 'sha256:fakeid\n')
})

test('an empty answer still stores a short report saying so', () => {
  const r = run({ answer: '  \n' })
  assert.equal(r.res.status, 0, r.res.stderr)
  assert.match(r.stored!, /empty/i)
  assert.equal(r.res.stdout.trimEnd().split('\n').at(-1), 'sha256:fakeid')
})

test('a failed claude still stores a report naming the exit code, sends it, and the launcher fails', () => {
  const r = run({ answer: 'partial', claudeExit: 3, env: { SYSTEM_NIGHT_NOTIFY_COMMAND: 'notify "$@"' } })
  assert.match(r.stored!, /failed/i)
  assert.match(r.stored!, /\b3\b/)
  assert.equal(r.notify, 'sha256:fakeid\n')
  assert.equal(r.res.status, 3)
})

test('a notifier that fails does not fail the night', () => {
  const r = run({ answer: 'report', env: { SYSTEM_NIGHT_NOTIFY_COMMAND: 'exit 9' } })
  assert.equal(r.res.status, 0)
  assert.match(r.res.stderr, /notif/i)
})

test('when the report cannot be stored the launcher fails', () => {
  const r = run({ answer: 'report', putExit: 2 })
  assert.notEqual(r.res.status, 0)
})

/** The prompt is the argument after `-p`; the fake claude writes one argument per line, so read it back whole. */
function promptOf(args: string) {
  return args.split('\n--output-format')[0]!.replace(/^-p\n/, '')
}
function checkout(name: string) {
  const d = mkdtempSync(join(tmpdir(), `night-repo-${name}-`))
  spawnSync('git', ['init', '-q', d])
  return d
}

test('without SYSTEM_NIGHT_REPOS the prompt names this repository only', () => {
  const r = run({ answer: 'report' })
  const p = promptOf(r.claudeArgs!)
  assert.ok(p.includes(`Repositories for this night:\n- ${repo}`), p.slice(-300))
  assert.equal((p.match(/^- \//gm) ?? []).length, 1)
})

test('SYSTEM_NIGHT_REPOS a:b names both checkouts, in order', () => {
  const a = checkout('a')
  const b = checkout('b')
  try {
    const r = run({ answer: 'report', env: { SYSTEM_NIGHT_REPOS: `${a}:${b}` } })
    assert.equal(r.res.status, 0, r.res.stderr)
    const p = promptOf(r.claudeArgs!)
    assert.ok(p.includes(`Repositories for this night:\n- ${a}\n- ${b}`), p.slice(-300))
    assert.ok(!p.includes(`- ${repo}\n`))
  } finally {
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

test('an entry that is not a git checkout is reported and skipped, not fatal', () => {
  const a = checkout('a')
  const bad = mkdtempSync(join(tmpdir(), 'night-notgit-'))
  try {
    const r = run({ answer: 'report', env: { SYSTEM_NIGHT_REPOS: `${bad}:${a}:/nonexistent/x` } })
    assert.equal(r.res.status, 0, r.res.stderr)
    const p = promptOf(r.claudeArgs!)
    assert.ok(p.includes(`Repositories for this night:\n- ${a}`) || p.includes(`night:\n- ${a}\n\n`), p.slice(-400))
    assert.ok(!p.includes(`- ${bad}\n`))
    assert.match(r.res.stderr, /not a git checkout/)
    assert.ok(p.includes(`Skipped, not a git checkout: ${bad}`), p.slice(-400))
    assert.ok(p.includes('Skipped, not a git checkout: /nonexistent/x'))
  } finally {
    rmSync(a, { recursive: true, force: true })
    rmSync(bad, { recursive: true, force: true })
  }
})

test('the prompt ends with the launcher\'s start time (ISO, UTC) and the prompt file names no date command', () => {
  const r = run({ answer: 'report' })
  assert.match(r.claudeArgs!, /^Session started at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m)
  const promptFile = readFileSync(join(repo, 'tools', 'night-session.md'), 'utf8')
  assert.doesNotMatch(promptFile, /date -u|date \+|\$\(date/)
  assert.match(promptFile, /do not run `date`/)
  assert.match(promptFile, /session start time/)
})
