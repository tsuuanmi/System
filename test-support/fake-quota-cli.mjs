#!/usr/bin/env node
/** Test-only line protocol peer. Append logs synchronously before replying or waiting. */
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const args = process.argv.slice(2)
const option = (key) => args.find((arg) => arg.startsWith(`--fake-${key}=`))?.split('=').slice(1).join('=')
const kind = option('kind')
const version = option('version')
const mode = option('mode')
const argv = args.filter((arg) => !arg.startsWith('--fake-'))
const log = (entry) => appendFileSync(option('log'), `${JSON.stringify(entry)}\n`)
const send = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`)
if (argv.includes('--version')) {
  log({ argv })
  console.log(version === 'garbage' ? version : kind === 'claude' ? `${version} (Claude Code)` : `codex-cli ${version}`)
} else {
  log({ argv, home: process.env.HOME, token: process.env.CLAUDE_CODE_OAUTH_TOKEN, codexHome: process.env.CODEX_HOME, envKeys: Object.keys(process.env), pid: process.pid })
  const answer = JSON.parse(readFileSync(option('answer'), 'utf8'))
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    const message = JSON.parse(line)
    log({ stdin: message })
    if (mode === 'exit') process.exit(0)
    if (mode === 'hang') { setInterval(() => {}, 1000); continue }
    if (mode === 'garbage') { console.log('not JSON'); continue }
    if (kind === 'claude') {
      if (message.type === 'control_request' && message.request?.subtype === 'get_usage') {
        send({ type: 'system', subtype: 'init' })
        send({ type: 'control_response', response: { request_id: message.request_id, ...(mode === 'error' ? { subtype: 'error', error: 'scripted failure' } : { subtype: 'success', response: answer }) } })
      }
    } else if (message.method === 'initialize') {
      send(mode === 'error' ? { id: message.id, error: { code: -1, message: 'scripted initialize failure' } } : { id: message.id, result: {} })
    } else if (message.method === 'account/rateLimits/read') send({ id: message.id, result: answer })
  }
}
