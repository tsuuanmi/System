#!/usr/bin/env node
// A fake GitHub API for tests, run as its own process (tests block in
// spawnSync while a host calls it). Prints its port. GET /_state returns the
// pull requests. With --kill-host-on-create <controlDir>, the first pull
// request it creates is followed by SIGKILL to every host whose Work lock is in
// that directory, before the response: a remote effect applied, never received.
// --kill-host-on-merge <controlDir> does the same after the first merge. The
// merge endpoint needs --bare <dir>, the remote the branches are pushed to, to
// compare `sha` with the head.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const flag = (name) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined
const killDir = flag('--kill-host-on-create')
const mergeKillDir = flag('--kill-host-on-merge')
const bare = flag('--bare')
let killed = false
let mergeKilled = false
const killHosts = (dir) => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.lock'))) {
    try { process.kill(Number(readFileSync(join(dir, file), 'utf8').split(' ')[0]), 'SIGKILL') } catch { /* gone */ }
  }
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
    const view = (p) => ({ ...p, html_url: `https://github.example/pull/${p.number}`, head: { ref: p.head, sha: bare ? headSha(p.head) : '' }, merged_at: p.merged ? '2026-11-06T00:00:00Z' : null, merge_commit_sha: p.mergeCommit ?? null })
    if (url.pathname === '/_state') return send(200, { pulls, calls })
    const match = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(url.pathname)
    if (req.method === 'GET' && match) {
      const all = url.searchParams.get('state') === 'all'
      return send(200, pulls.filter((p) => p.head === url.searchParams.get('head').split(':')[1] && (all || !p.merged)).map(view))
    }
    const merge = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/merge$/.exec(url.pathname)
    if (req.method === 'PUT' && merge) {
      const pull = pulls.find((p) => p.number === Number(merge[2]))
      const input = JSON.parse(body)
      if (pull.merged || pull.draft) return send(405, { message: 'Pull Request is not mergeable' })
      if (input.sha !== headSha(pull.head)) return send(409, { message: 'Head branch was modified. Review and try the merge again.' })
      pull.merged = true
      pull.mergeCommit = execFileSync('git', ['-C', bare, 'commit-tree', '-p', input.sha, '-m', 'merge', `${input.sha}^{tree}`], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
      if (mergeKillDir && !mergeKilled) {
        mergeKilled = true
        killHosts(mergeKillDir)
        return res.destroy()
      }
      return send(200, { sha: pull.mergeCommit, merged: true, message: 'Pull Request successfully merged' })
    }
    if (req.method === 'POST' && match) {
      const input = JSON.parse(body)
      const pull = { number: pulls.length + 1, head: input.head, base: input.base, draft: input.draft, title: input.title, node_id: `PR_${pulls.length + 1}` }
      pulls.push(pull)
      if (killDir && !killed) {
        killed = true
        killHosts(killDir)
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
