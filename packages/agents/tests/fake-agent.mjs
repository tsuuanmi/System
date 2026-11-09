#!/usr/bin/env node
// A stand-in for `claude -p` and `codex exec` in tests. Behavior comes from
// markers in the prompt's instructions:
//   FAKE:edit     write NOTE.md in the working directory
//   FAKE:append   with FAKE:edit, add to NOTE.md instead of replacing it, so an attempt on an earlier change is a change again
//   FAKE:outputs  write every listed output file
//   FAKE:sign     with FAKE:outputs, each file names its runtime, repeats the prompt's Context header and quotes every input file listed
//   FAKE:hang=STEP:FILE  at step STEP, unless FILE exists: create it and wait (until SIGTERM, then exit 143)
//   FAKE:cite=URL with FAKE:outputs, "sources" cites URL with the quote QUOTE below, and every other output ends with the citation [s1]
//   FAKE:sleep    unless PARTIAL.md exists: wait; on SIGTERM write PARTIAL.md and exit 143
//   FAKE:stubborn ignore SIGTERM (the grace then ends in SIGKILL)
//   FAKE:grandchild=FILE  start a process in the agent's own group that waits, and write its pid to FILE
//   FAKE:escaped=FILE     the same, but in a session of its own (setsid), as a `system host` a test started might be
//   FAKE:holdstdout=FILE  with FAKE:outputs, leave a process in the agent's group that holds stdout open (as a leaked Xvfb does) and write its pid to FILE
//   FAKE:delay=MS finish only after MS milliseconds, so attempts can be seen to overlap
//   FAKE:turns    (claude, stream-json) first print two assistant messages that use tools, as progress
//   FAKE:background=FILE  (claude) start a background job (its pid in FILE), unless background tasks are disabled and Monitor is disallowed
//   FAKE:fail     report an error
//   FAKE:env      write the environment's variable names to ENV.json
//   FAKE:followup (claude) emit two results with different usage, as a background command's notification starts a second turn
//   FAKE:noise    with FAKE:followup, print 300 KB of other events between the results
//   FAKE:refresh  (codex) rewrite $CODEX_HOME/auth.json, as a token refresh does
// The model given with --model / -m is written into ENV.json and reported as served.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const codex = args[0] === 'exec'
if (args[0] === '--version') {
  console.log(codex ? 'codex-cli 0.0.0-fake' : '0.0.0-fake (Claude Code)')
  process.exit(0)
}
const prompt = codex ? args.at(-1) : args[args.indexOf('-p') + 1]
const has = (marker) => prompt.includes(`FAKE:${marker}`)
const cwd = process.cwd()
const flag = codex ? '-m' : '--model'
const model = args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined

function finish(ok, message) {
  if (codex) {
    console.log(JSON.stringify({ type: 'thread.started' }))
    if (ok) {
      console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: message } }))
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
      return JSON.stringify({ type: 'result', is_error: !ok, result: message, usage, total_cost_usd: cost + 0.25, modelUsage: { [main]: perModel(usage, cost), 'served-subagent': perModel(subagent, 0.25) } })
    }
    // `--output-format stream-json` prints every event as a line; the json format prints only the last result.
    const stream = args.includes('stream-json')
    if (stream) console.log(JSON.stringify({ type: 'system', subtype: 'init' }))
    if (has('followup')) {
      const first = result({ input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 }, 0.5)
      if (stream) console.log(first)
      if (stream && has('noise')) console.log(JSON.stringify({ type: 'assistant', text: 'x'.repeat(300 * 1024) }))
      console.log(result({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 4, output_tokens: 6 }, 0.25))
    } else {
      console.log(result({ input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 }, 0.5))
    }
  }
  // Exit only once stdout is flushed: a pipe takes a large write asynchronously.
  process.stdout.write('', () => process.exit(ok ? 0 : 1))
}

if (!codex && has('turns') && args.includes('stream-json')) {
  for (const [id, tool] of [['m1', 'Bash'], ['m2', 'Read']]) console.log(JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'tool_use', name: tool }], usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 3 } } }))
}
const background = /FAKE:background=(\S+)/.exec(prompt)?.[1]
const refused = process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS === '1' && args.slice(args.indexOf('--disallowedTools')).includes('Monitor')
if (!codex && background && !refused) writeFileSync(background, String(spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { detached: true, stdio: 'ignore' }).pid))
if (has('env')) writeFileSync(join(cwd, 'ENV.json'), JSON.stringify({ keys: Object.keys(process.env).sort(), home: process.env.HOME, codexHome: process.env.CODEX_HOME, codexHomeFiles: process.env.CODEX_HOME ? readdirSync(process.env.CODEX_HOME) : [], model }))
if (has('edit')) (has('append') ? appendFileSync : writeFileSync)(join(cwd, 'NOTE.md'), `edited by ${codex ? 'codex' : 'claude'}\n`)
/** An output naming who wrote it and quoting each input file, so a test can see what a step read. */
function signed(slot) {
  const read = [...prompt.matchAll(/^- ([a-z][a-z0-9-]*): (\/\S+)$/gm)].map(([, name, path]) => `## ${name}\n${readFileSync(path, 'utf8')}`)
  const context = prompt.split('\n').find((line) => line.startsWith('Context ('))
  return [`# ${slot} by ${codex ? 'codex' : 'claude'}`, ...(context ? [context] : []), ...read].join('\n')
}
const QUOTE = 'System verifies citations exactly'
const cited = /FAKE:cite=(\S+)/.exec(prompt)?.[1]
if (has('outputs')) {
  for (const [, slot, path] of prompt.matchAll(/^- ([a-z][a-z0-9-]*) \(the file (\/[^)]+)\)$/gm)) {
    const sources = { sources: cited ? [{ id: 's1', url: cited, quote: QUOTE, claims: ['System checks quotes'] }] : [] }
    writeFileSync(path, slot === 'sources' ? `${JSON.stringify(sources)}\n` : has('sign') ? `${signed(slot)}${cited ? '\n[s1]\n' : ''}` : `# ${slot} [s1]\n`)
  }
}
if (codex && has('refresh')) appendFileSync(join(process.env.CODEX_HOME, 'auth.json'), '\n')
if (has('fail')) finish(false, 'scripted failure')
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
} else {
  const delay = Number(/FAKE:delay=(\d+)/.exec(prompt)?.[1] ?? 0)
  setTimeout(() => finish(true, 'done'), delay)
}
