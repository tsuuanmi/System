// The front of `system mcp` (Item mcp-2): it owns the session's stdio and runs the MCP server of the release the install's
// `current` link points to as a child (`bin/system mcp` with SYSTEM_MCP_CHILD=1). When the link moves (a `system update`), or the
// child exits, it starts the child again from `current`, replays the session's `initialize` and `notifications/initialized`,
// sends `notifications/tools/list_changed`, and forwards the requests still unanswered and the new ones. Client fixes of a new
// release therefore reach a session that began days earlier. It knows no MCP method but those three and imports nothing of a
// release, so it needs no change to pick up later fixes; its own code is read once, when the session starts (an update of this
// file reaches the sessions started after it).
import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

/** Newline-delimited JSON messages: the line, and its parsed form when it is a JSON object. */
const parse = (line) => { try { const value = JSON.parse(line); return value && typeof value === 'object' ? value : undefined } catch { return undefined } }

/**
 * Serve one session: `install` is the `current` link (or a checkout), `pollMs` how often an idle session looks at the link.
 * Resolves the exit code once the client closes stdin and the child has ended.
 */
export function front({ install, args = [], env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, pollMs = 30_000, node = process.execPath }) {
  return new Promise((done) => {
    const target = () => { try { return realpathSync(install) } catch { return undefined } }
    let child
    let release
    let swapping = false
    let ended = false
    let starts = []
    let initialize
    let initialized
    let swaps = 0
    /** Requests sent to the child and not answered yet, by id; a new child gets them again. */
    const pending = new Map()
    const hidden = new Set()

    const send = (line) => { if (child?.stdin.writable) child.stdin.write(`${line}\n`) }

    const start = () => {
      release = target()
      if (release === undefined) { stderr.write('system mcp: the install has no current release\n'); finish(1); return }
      starts = [...starts.filter((at) => Date.now() - at < 10_000), Date.now()]
      if (starts.length > 5) { stderr.write('system mcp: the server keeps exiting; giving up\n'); finish(1); return }
      const spawned = spawn(node, [join(release, 'bin', 'system'), 'mcp', ...args], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...env, SYSTEM_MCP_CHILD: '1' } })
      child = spawned
      spawned.stdin.on('error', () => {})
      createInterface({ input: spawned.stdout }).on('line', (line) => {
        if (child !== spawned) return
        const message = parse(line)
        if (message && message.method === undefined && 'id' in message) {
          if (hidden.delete(message.id)) return
          pending.delete(message.id)
        }
        stdout.write(`${line}\n`)
      })
      spawned.on('error', (error) => { stderr.write(`system mcp: ${error.message}\n`) })
      spawned.on('exit', (code) => {
        if (child !== spawned) return
        // A clean exit, or the usage error (2) of a bad argument, is the session's end; any other exit is a crash.
        if (ended || code === 0 || code === 2) { finish(code ?? 0); return }
        // The child went away by itself: run the server of `current` again.
        launch()
      })
    }

    /** Start a child and bring it to where the session is: initialized, then the unanswered requests. */
    const launch = () => {
      swaps++
      start()
      if (!child || initialize === undefined) { for (const line of pending.values()) send(line); return }
      const id = `mcp-front-${swaps}`
      hidden.add(id)
      send(JSON.stringify({ ...initialize, id }))
      if (initialized) send(initialized)
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`)
      for (const line of pending.values()) send(line)
    }

    /** The link points to another release than the child's: replace the child. */
    const swap = () => {
      const now = target()
      if (ended || swapping || child === undefined || now === undefined || now === release) return
      const old = child
      swapping = true
      child = undefined
      old.kill('SIGTERM')
      swapping = false
      launch()
    }

    const finish = (code) => {
      clearInterval(timer)
      done(code)
    }

    stdin.setEncoding('utf8')
    createInterface({ input: stdin }).on('line', (line) => {
      if (!line.trim()) return
      const message = parse(line)
      if (message?.method === 'initialize') initialize = message
      else if (message?.method === 'notifications/initialized') initialized = line
      swap()
      if (message && message.method !== undefined && 'id' in message) pending.set(message.id, line)
      send(line)
    })
    stdin.on('end', () => {
      ended = true
      if (child === undefined) { finish(0); return }
      child.stdin.end()
    })
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { ended = true; child?.kill(signal) })
    const timer = setInterval(swap, pollMs)
    timer.unref()
    launch()
  })
}
