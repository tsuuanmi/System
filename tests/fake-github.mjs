#!/usr/bin/env node
// A fake GitHub API for tests, run as its own process (tests block in
// spawnSync while a host calls it). Prints its port. GET /_state returns the
// pull requests. With --kill-host-on-create <controlDir>, the first pull
// request it creates is followed by SIGKILL to every host whose Work lock is in
// that directory, before the response: a remote effect applied, never received.
import { readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const killDir = process.argv.includes('--kill-host-on-create') ? process.argv[process.argv.indexOf('--kill-host-on-create') + 1] : undefined
let killed = false
const pulls = []
const calls = []

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    calls.push(`${req.method} ${req.url}`)
    const url = new URL(req.url, 'http://x')
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    const view = (p) => ({ ...p, html_url: `https://github.example/pull/${p.number}`, head: { ref: p.head } })
    if (url.pathname === '/_state') return send(200, { pulls, calls })
    const match = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(url.pathname)
    if (req.method === 'GET' && match) return send(200, pulls.filter((p) => p.head === url.searchParams.get('head').split(':')[1]).map(view))
    if (req.method === 'POST' && match) {
      const input = JSON.parse(body)
      const pull = { number: pulls.length + 1, head: input.head, base: input.base, draft: input.draft, title: input.title, node_id: `PR_${pulls.length + 1}` }
      pulls.push(pull)
      if (killDir && !killed) {
        killed = true
        for (const file of readdirSync(killDir).filter((f) => f.endsWith('.lock'))) {
          try { process.kill(Number(readFileSync(join(killDir, file), 'utf8').split(' ')[0]), 'SIGKILL') } catch { /* gone */ }
        }
        return res.destroy()
      }
      return send(201, view(pull))
    }
    if (req.method === 'POST' && url.pathname === '/graphql') {
      const pull = pulls.find((p) => p.node_id === JSON.parse(body).variables.id)
      pull.draft = false
      return send(200, { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } })
    }
    send(404, { message: 'not found' })
  })
})
server.listen(0, '127.0.0.1', () => console.log(server.address().port))
