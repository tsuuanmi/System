#!/usr/bin/env node
// A fake GitHub API for tests, run as its own process (tests block in
// spawnSync while a host calls it). Prints its port. GET /_state returns the
// pull requests. With --kill-host-on-create <pidFile>, the first pull
// request it creates is followed by SIGKILL to the Host whose process ID is in
// that file, before the response: a remote effect applied, never received.
// --bare <dir>, the remote the branches are pushed to, gives each pull
// request its head's sha.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const flag = (name) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined
const killFile = flag('--kill-host-on-create')
const bare = flag('--bare')
let killed = false
const killHost = (pidFile) => {
  try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL') } catch { /* gone */ }
}
const headSha = (branch) => {
  try { return execFileSync('git', ['-C', bare, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
}
const pulls = []
const calls = []

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d })
  req.on('end', () => {
    calls.push(`${req.method} ${req.url}`)
    const url = new URL(req.url, 'http://x')
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    const view = (p) => ({ ...p, html_url: `https://github.example/pull/${p.number}`, base: { ref: p.base }, head: { ref: p.head, sha: bare ? headSha(p.head) : '' }, merged_at: p.merged ? '2026-11-06T00:00:00Z' : null, merge_commit_sha: p.mergeCommit ?? null })
    if (url.pathname === '/_state') return send(200, { pulls, calls })
    const match = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(url.pathname)
    if (req.method === 'GET' && match) {
      const all = url.searchParams.get('state') === 'all'
      return send(200, pulls.filter((p) => p.head === url.searchParams.get('head').split(':')[1] && (all || !p.merged)).map(view))
    }
    if (req.method === 'POST' && match) {
      const input = JSON.parse(body)
      const pull = { number: pulls.length + 1, head: input.head, base: input.base, draft: input.draft, title: input.title, node_id: `PR_${pulls.length + 1}` }
      pulls.push(pull)
      if (killFile && !killed) {
        killed = true
        killHost(killFile)
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
