#!/usr/bin/env node
// A stand-in for `claude -p` and `codex exec` in tests. Behavior comes from
// markers in the prompt's instructions:
//   FAKE:edit     write NOTE.md in the working directory
//   FAKE:append   with FAKE:edit, add to NOTE.md instead of replacing it, so an attempt on an earlier change is a change again
//   FAKE:outputs  write every listed output file
//   FAKE:satisfied  write the optional output listed (the one named `satisfied`) with the line `t/ok.test.mjs "holds"`, and change nothing
//   FAKE:sign     with FAKE:outputs, each file names its runtime, repeats the prompt's Context header and quotes every input file listed
//   FAKE:hang=STEP:FILE  at step STEP, unless FILE exists: create it and wait (until SIGTERM, then exit 143)
//   FAKE:cite=URL with FAKE:outputs, "sources" cites URL with the quote QUOTE below, and every other output ends with the citation [s1]
//   FAKE:sleep    unless PARTIAL.md exists: wait; on SIGTERM write PARTIAL.md and exit 143
//   FAKE:stubborn ignore SIGTERM (the grace then ends in SIGKILL)
//   FAKE:ready=FILE  with FAKE:sleep or FAKE:stubborn, create FILE once the SIGTERM handler is in place, so a test stops the agent on that, not after a delay
//   FAKE:grandchild=FILE  start a process in the agent's own group that waits, and write its pid to FILE
//   FAKE:escaped=FILE     the same, but in a session of its own (setsid), as a `system host` a test started might be
//   FAKE:holdstdout=FILE  with FAKE:outputs, leave a process in the agent's group that holds stdout open (as a leaked Xvfb does) and write its pid to FILE
//   FAKE:delay=MS finish only after MS milliseconds, so attempts can be seen to overlap
//   FAKE:barrier=DIR:COUNT  write one marker file in DIR and wait until DIR holds at least COUNT files (proving overlap without a fixed sleep)
//   FAKE:turns    (claude, stream-json) first print two assistant messages that use tools, as progress
//   FAKE:background=FILE  (claude) start a background job (its pid in FILE), unless background tasks are disabled and Monitor is disallowed
//   FAKE:fail     report an error
//   FAKE:blocked=REASON  (claude, codex, agy) end with structured result { status: 'blocked', reason: REASON }
//   FAKE:no-result       (claude, codex, agy) omit the structured final result
//   FAKE:invalid-result  (claude) end with a structured result that is not {status: done|blocked, reason}
//   FAKE:cause=LABEL  (cls-1) with FAKE:fail, the error message carries this marker; a Classifier question (a prompt that says "Reply with only a JSON object") that quotes it is answered {"label":"LABEL"}
//   FAKE:env      write the environment's variable names to ENV.json
//   FAKE:followup (claude) emit two results with different usage, as a background command's notification starts a second turn
//   FAKE:noise    with FAKE:followup, print 400 KiB of other events between the results
//   FAKE:ratelimit=<five_hour|seven_day>:<fraction> (claude, stream-json) emit a quota event before the result
//   FAKE:unified=<five>,<seven> (claude, stream-json) emit both fractional unified quota windows
//   (agy: told by `--mode`; prints the init and result events of `--output-format stream-json`, and FAKE:fail prints an ERROR result)
//   FAKE:refresh  (codex) rewrite $CODEX_HOME/auth.json, as a token refresh does
// The model given with --model / -m is written into ENV.json and reported as served.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const codex = args[0] === 'exec'
if (args[0] === '--version') {
  console.log(codex ? 'codex-cli 0.0.0-fake' : '0.0.0-fake (Claude Code)')
  process.exit(0)
}
const agy = args.includes('--mode')
const prompt = codex ? args.at(-1) : args[args.indexOf('-p') + 1]
const has = (marker) => prompt.includes(`FAKE:${marker}`)
const cwd = process.cwd()
const flag = codex ? '-m' : '--model'
const model = args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined

const cause = /FAKE:cause=(\S+)/.exec(prompt)?.[1]
const blockedReason = /FAKE:blocked=([^\n]+)/.exec(prompt)?.[1]

function finish(ok, message) {
  const structured = !has('no-result') && (codex ? args.includes('-o') : args.includes('--json-schema'))
  const payload = structured ? JSON.stringify({ status: blockedReason ? 'blocked' : 'done', reason: blockedReason ?? message }) : message
  if (agy) {
    console.log(JSON.stringify({ event: 'init', init: { model, cwd: process.cwd() } }))
    const usage = { input_tokens: 100, output_tokens: 7, thinking_tokens: 0, cache_read_tokens: 40, total_tokens: 107 }
    console.log(JSON.stringify({ event: 'result', result: ok ? { status: 'SUCCESS', response: payload, num_turns: 1, usage } : { status: 'ERROR', error: message } }))
  } else if (codex) {
    console.log(JSON.stringify({ type: 'thread.started' }))
    if (ok) {
      if (structured && args.includes('-o')) writeFileSync(args[args.indexOf('-o') + 1], payload)
      console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: payload } }))
      console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } }))
    } else {
      console.log(JSON.stringify({ type: 'turn.failed', error: { message } }))
    }
  } else {
    const main = model ? `served-${model}` : 'served-default'
    /** `usage` is the main model's alone; `modelUsage` adds a second model standing in for a subagent, as the real CLI does. */
    const result = (usage, cost) => {
      const perModel = (u, costUSD) => ({ inputTokens: u.input_tokens, cacheReadInputTokens: u.cache_read_input_tokens, cacheCreationInputTokens: u.cache_creation_input_tokens, outputTokens: u.output_tokens, costUSD })
      const subagent = { input_tokens: 100, cache_creation_input_tokens: 25, cache_read_input_tokens: 100, output_tokens: 20 }
      return JSON.stringify({ type: 'result', is_error: !ok, result: message, usage, total_cost_usd: cost + 0.25, ...(structured ? { structured_output: has('invalid-result') ? { status: 'maybe' } : JSON.parse(payload) } : {}), modelUsage: { [main]: perModel(usage, cost), 'served-subagent': perModel(subagent, 0.25) } })
    }
    // `--output-format stream-json` prints every event as a line; the json format prints only the last result.
    const stream = args.includes('stream-json')
    if (stream) console.log(JSON.stringify({ type: 'system', subtype: 'init' }))
    const rate = /FAKE:ratelimit=(five_hour|seven_day):([0-9.]+)/.exec(prompt)
    if (stream && rate) console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: rate[1], utilization: Number(rate[2]), resetsAt: Math.floor(Date.now() / 1000) + 3600 } }))
    const unified = /FAKE:unified=([0-9.]+),([0-9.]+)/.exec(prompt)
    if (stream && unified) {
      const resetsAt = Math.floor(Date.now() / 1000) + 3600
      console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {
        status: 'allowed', resetsAt, rateLimitType: 'five_hour', unifiedWindows: {
          five_hour: { utilization: Number(unified[1]), resetsAt, status: 'allowed' },
          seven_day: { utilization: Number(unified[2]), resetsAt: resetsAt + 6 * 86400, status: 'allowed' },
        },
      } }))
    }
    if (has('followup')) {
      const first = result({ input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 }, 0.5)
      if (stream) console.log(first)
      if (stream && has('noise')) console.log(JSON.stringify({ type: 'assistant', text: 'x'.repeat(400 * 1024) }))
      console.log(result({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 4, output_tokens: 6 }, 0.25))
    } else {
      console.log(result({ input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 }, 0.5))
    }
  }
  // Exit only once stdout is flushed: a pipe takes a large write asynchronously.
  process.stdout.write('', () => process.exit(ok ? 0 : 1))
}

// A Classifier question: answered at once, nothing else done.
if (cause && prompt.includes('Reply with only a JSON object')) {
  finish(true, JSON.stringify({ label: cause }))
  await new Promise(() => {})
}

if (!codex && has('turns') && args.includes('stream-json')) {
  for (const [id, tool] of [['m1', 'Bash'], ['m2', 'Read']]) console.log(JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'tool_use', name: tool }], usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 3 } } }))
}
const background = /FAKE:background=(\S+)/.exec(prompt)?.[1]
const refused = process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS === '1' && args.slice(args.indexOf('--disallowedTools')).includes('Monitor')
if (!codex && background && !refused) writeFileSync(background, String(spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { detached: true, stdio: 'ignore' }).pid))
const homeFile = /FAKE:home=(\S+)/.exec(prompt)?.[1]
const homeFilesBefore = homeFile && process.env.HOME ? readdirSync(process.env.HOME).sort() : undefined
if (homeFile && process.env.HOME) writeFileSync(join(process.env.HOME, homeFile), 'attempt-file\n')
// FAKE:brain  (agy) write and read back agy's working file under $HOME/.gemini/antigravity-cli/brain, as agy does for long tool output
let brain
if (agy && has('brain')) {
  const dir = join(process.env.HOME, '.gemini', 'antigravity-cli', 'brain')
  const before = existsSync(dir) ? readdirSync(dir).sort() : []
  mkdirSync(join(dir, 'c1'), { recursive: true })
  const file = join(dir, 'c1', 'scratch.txt')
  writeFileSync(file, 'scratch\n')
  brain = { before, realHome: realpathSync(process.env.HOME), real: realpathSync(file), content: readFileSync(file, 'utf8'), token: readFileSync(join(process.env.HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'utf8') }
}
if (has('env')) writeFileSync(join(cwd, 'ENV.json'), JSON.stringify({ ...(brain ? { brain } : {}), keys: Object.keys(process.env).sort(), home: process.env.HOME, path: process.env.PATH, codexHome: process.env.CODEX_HOME, dbus: process.env.DBUS_SESSION_BUS_ADDRESS, codexHomeFiles: process.env.CODEX_HOME ? readdirSync(process.env.CODEX_HOME) : [], ...(homeFilesBefore ? { homeFilesBefore } : {}), model }))
if (has('edit')) (has('append') ? appendFileSync : writeFileSync)(join(cwd, 'NOTE.md'), `edited by ${codex ? 'codex' : agy ? 'agy' : 'claude'}\n`)
/** An output naming who wrote it and quoting each input file, so a test can see what a step read. */
function signed(slot) {
  const read = [...prompt.matchAll(/^- ([a-z][a-z0-9-]*): (\/\S+)(?: \(artifact [^)]*\))?$/gm)].map(([, name, path]) => `## ${name}\n${readFileSync(path, 'utf8')}`)
  const lines = prompt.split('\n')
  const at = lines.findIndex((line) => line.startsWith('Context ('))
  const context = at < 0 ? [] : lines.slice(at, at + lines.slice(at).indexOf(''))
  return [`# ${slot} by ${codex ? 'codex' : 'claude'}`, ...context, ...read].join('\n')
}
const QUOTE = 'System verifies citations exactly'
const cited = /FAKE:cite=(\S+)/.exec(prompt)?.[1]
if (has('outputs')) {
  for (const [, slot, path] of prompt.matchAll(/^- ([a-z][a-z0-9-]*) \(the file (\/[^)]+)\)$/gm)) {
    const sources = { sources: cited ? [{ id: 's1', url: cited, quote: QUOTE, claims: ['System checks quotes'] }] : [] }
    writeFileSync(path, slot === 'sources' ? `${JSON.stringify(sources)}\n` : has('sign') ? `${signed(slot)}${cited ? '\n[s1]\n' : ''}` : `# ${slot} [s1]\n`)
  }
}
if (has('satisfied')) {
  for (const [, , path] of prompt.matchAll(/^- (satisfied) \(optional, the file (\/[^)]+)\)$/gm)) writeFileSync(path, 't/ok.test.mjs "holds"\n')
}
if (codex && has('refresh')) appendFileSync(join(process.env.CODEX_HOME, 'auth.json'), '\n')
if (has('fail')) finish(false, cause ? `scripted failure FAKE:cause=${cause}` : 'scripted failure')
const held = /FAKE:holdstdout=(\S+)/.exec(prompt)?.[1]
if (held) writeFileSync(held, String(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] }).pid))
for (const [marker, detached] of [['grandchild', false], ['escaped', true]]) {
  const pidFile = new RegExp(`FAKE:${marker}=(\\S+)`).exec(prompt)?.[1]
  if (pidFile) writeFileSync(pidFile, String(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached, stdio: 'ignore' }).pid))
}
const hang = /FAKE:hang=([a-z0-9-]+):(\S+)/.exec(prompt)
if (hang && prompt.includes(`Step: ${hang[1]}\n`) && !existsSync(hang[2])) {
  writeFileSync(hang[2], '')
  process.on('SIGTERM', () => process.exit(143))
  setTimeout(() => process.exit(1), 120_000)
  setInterval(() => {}, 1000)
} else if ((has('sleep') && !existsSync(join(cwd, 'PARTIAL.md'))) || has('stubborn')) {
  process.on('SIGTERM', () => {
    if (has('stubborn')) return
    writeFileSync(join(cwd, 'PARTIAL.md'), 'half done\n')
    process.exit(143)
  })
  setInterval(() => {}, 1000)
  const ready = /FAKE:ready=(\S+)/.exec(prompt)?.[1]
  if (ready) writeFileSync(ready, '')
} else {
  const barrier = /FAKE:barrier=([^:\s]+):(\d+)(?::(\d+))?/.exec(prompt)
  if (barrier) {
    const [, dir, needed, timeoutMs] = barrier
    writeFileSync(join(dir, `${process.pid}-${Math.random().toString(36).slice(2)}`), '')
    const deadline = Date.now() + Number(timeoutMs ?? 60_000)
    while (readdirSync(dir).length < Number(needed)) {
      if (Date.now() > deadline) {
        finish(false, `barrier ${dir} did not reach ${needed}`)
        await new Promise(() => {})
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    finish(true, 'done')
  } else {
    const delay = Number(/FAKE:delay=(\d+)/.exec(prompt)?.[1] ?? 0)
    setTimeout(() => finish(true, 'done'), delay)
  }
}
