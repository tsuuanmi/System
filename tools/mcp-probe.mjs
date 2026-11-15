#!/usr/bin/env node
// The `mcp` afterInstall check of .system/checks.yaml (Item fl-6): start an MCP server over stdio, send `initialize`,
// `notifications/initialized` and `tools/list`, and exit 0 only when the server lists at least one tool. Plain Node, no dependency.
//   node tools/mcp-probe.mjs [--timeout <seconds, default 30>] -- <command> [args...]
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
const split = argv.indexOf('--')
const options = split < 0 ? argv : argv.slice(0, split)
const command = split < 0 ? [] : argv.slice(split + 1)
const t = options.indexOf('--timeout')
const timeout = t >= 0 ? Number(options[t + 1]) : 30
if (command.length === 0 || !(timeout > 0)) {
  console.error('usage: mcp-probe.mjs [--timeout <seconds>] -- <command> [args...]')
  process.exit(2)
}

const fail = (message) => {
  console.error(`mcp-probe: ${message}`)
  child.kill('SIGKILL')
  process.exit(1)
}
const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] })
child.on('error', (error) => fail(`could not start ${command.join(' ')}: ${error.message}`))
child.on('exit', (code, signal) => fail(`${command.join(' ')} exited (${code ?? signal}) before answering`))
child.stdin.on('error', () => {})
const timer = setTimeout(() => fail(`timed out after ${timeout} s waiting for ${waiting}`), timeout * 1000)
const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

let waiting = 'initialize'
send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-probe', version: '0' } } })
for await (const line of createInterface({ input: child.stdout })) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    continue
  }
  if (message.error) fail(`${waiting} was refused: ${JSON.stringify(message.error)}`)
  if (message.id === 1 && waiting === 'initialize') {
    send({ method: 'notifications/initialized' })
    waiting = 'tools/list'
    send({ id: 2, method: 'tools/list', params: {} })
  } else if (message.id === 2) {
    const tools = message.result?.tools
    if (!Array.isArray(tools) || tools.length === 0) fail('tools/list answered with no tool')
    clearTimeout(timer)
    console.log(`mcp-probe: ${tools.length} tool${tools.length === 1 ? '' : 's'} listed (${tools.slice(0, 3).map((x) => x.name).join(', ')}${tools.length > 3 ? ', ...' : ''})`)
    child.removeAllListeners('exit')
    child.kill()
    process.exit(0)
  }
}
