#!/usr/bin/env node
// A stand-in for `claude -p` and `codex exec` in tests. Behavior comes from
// markers in the prompt's instructions:
//   FAKE:edit     write NOTE.md in the working directory
//   FAKE:outputs  write every listed output file
//   FAKE:sign     with FAKE:outputs, each file names its runtime and quotes every input file read
//   FAKE:hang=STEP:FILE  at step STEP, unless FILE exists: create it and wait (until SIGTERM, then exit 143)
//   FAKE:cite=URL with FAKE:outputs, "sources" cites URL with the quote QUOTE below
//   FAKE:sleep    unless PARTIAL.md exists: wait; on SIGTERM write PARTIAL.md and exit 143
//   FAKE:stubborn ignore SIGTERM (the grace then ends in SIGKILL)
//   FAKE:fail     report an error
//   FAKE:env      write the environment's variable names to ENV.json
//   FAKE:refresh  (codex) rewrite $CODEX_HOME/auth.json, as a token refresh does
// The model given with --model / -m is written into ENV.json and reported as served.
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
    console.log(JSON.stringify({ type: 'result', is_error: !ok, result: message, usage: { input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 5 }, modelUsage: { [model ? `served-${model}` : 'served-default']: {} } }))
  }
  process.exit(ok ? 0 : 1)
}

if (has('env')) writeFileSync(join(cwd, 'ENV.json'), JSON.stringify({ keys: Object.keys(process.env).sort(), home: process.env.HOME, codexHome: process.env.CODEX_HOME, codexHomeFiles: process.env.CODEX_HOME ? readdirSync(process.env.CODEX_HOME) : [], model }))
if (has('edit')) writeFileSync(join(cwd, 'NOTE.md'), `edited by ${codex ? 'codex' : 'claude'}\n`)
/** An output naming who wrote it and quoting each input file, so a test can see what a step read. */
function signed(slot) {
  const read = [...prompt.matchAll(/^- ([a-z][a-z0-9-]*): (\/\S+)$/gm)].map(([, name, path]) => `## ${name}\n${readFileSync(path, 'utf8')}`)
  return [`# ${slot} by ${codex ? 'codex' : 'claude'}`, ...read].join('\n')
}
const QUOTE = 'System verifies citations exactly'
const cited = /FAKE:cite=(\S+)/.exec(prompt)?.[1]
if (has('outputs')) {
  for (const [, slot, path] of prompt.matchAll(/^- ([a-z][a-z0-9-]*) \(the file (\/[^)]+)\)$/gm)) {
    const sources = { sources: cited ? [{ id: 's1', url: cited, quote: QUOTE, claims: ['System checks quotes'] }] : [] }
    writeFileSync(path, slot === 'sources' ? `${JSON.stringify(sources)}\n` : has('sign') ? signed(slot) : `# ${slot} [s1]\n`)
  }
}
if (codex && has('refresh')) appendFileSync(join(process.env.CODEX_HOME, 'auth.json'), '\n')
if (has('fail')) finish(false, 'scripted failure')
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
  finish(true, 'done')
}
