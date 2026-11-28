/**
 * Deterministic caller for carrying out Items of `STATUS.md` (ADR-0020 decisions 1–5):
 * no model call anywhere; fixed rules for skipping, claiming, storing the Task, picking the
 * Workflow, submitting, waiting, retrying once with the failed Work's verdict, running a
 * multi-repository pass in parallel up to free Accounts and `--max-parallel`, storing a
 * Markdown report Artifact, failing loudly, and sending a one-line verdict to the notifier.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { NotAnswering, NotRunning, RpcError, UPGRADING, codeRoot } from '@system/host'
import type { WorkEvent, WorkRecord } from '@system/work'
import { errorLine, explain, operatorId } from './io.ts'
import type { WorkersView } from './cli.ts'
import { readWorkflowFile, type HostClient } from './remote.ts'
import { readSchedule } from './schedule.ts'

export interface ItemsIo {
  out(text: string): void
  err(text: string): void
}

export interface CarryPassOptions {
  maxParallel?: number
  home?: string
  now?: () => Date
  /** How long to wait for the Host to answer at the start of the pass (ms); 0 or unset means do not wait. */
  waitForHostMs?: number
  /** Delay between Host checks while waiting (ms). */
  waitIntervalMs?: number
}

export interface CarryScheduleOptions {
  check?: boolean
  home?: string
  now?: () => Date
  waitForHostMs?: number
  waitIntervalMs?: number
}

interface ItemCarryResult {
  item: string
  repository?: string
  works: string[]
  outcome: string
  reason?: string
  account: string | null
  tokens: number
  cacheReadShare?: number | null
  cost: number | null
}

function canonicalRepo(path: string): string {
  const abs = resolve(path)
  try { return realpathSync(abs) } catch { return abs }
}

function sameRepository(record: WorkRecord, repository: string): boolean {
  const first = record.events[0]
  if (first?.type !== 'admitted' || !first.item?.repository) return true
  return first.item.repository === repository || canonicalRepo(first.item.repository) === canonicalRepo(repository)
}

function workflowPathFor(repository: string, itemLine: string): string {
  const head = itemLine.split(' - ', 1)[0] ?? ''
  const match = /\(workflow:\s*([a-z0-9][a-z0-9-]*)\)/.exec(head)
  const file = `${match?.[1] ?? 'develop'}.yaml`
  const repoFile = join(repository, 'workflows', file)
  return existsSync(repoFile) ? repoFile : join(codeRoot(), 'workflows', file)
}

const isMerged = (record: WorkRecord): boolean =>
  Object.values(record.state.effects ?? {}).some((e) => e.state === 'applied' && e.detail?.merged === 'true')

const verdictOf = (record: WorkRecord): string | undefined =>
  record.events.findLast((e): e is Extract<WorkEvent, { type: 'verified' }> => e.type === 'verified' && e.verdict !== 'pass' && !!e.verdictId)?.verdictId

function summaryOf(records: WorkRecord[]): { account: string | null; tokens: number; cacheReadShare: number | null; cost: number | null } {
  let account: string | null = null
  let tokens = 0
  let cacheReadTokens = 0
  let splitInputTokens = 0
  let cost: number | null = null
  for (const record of records) {
    const dispatched = record.events.findLast((e) => e.type === 'dispatched' && e.executor === 'worker')
    if (dispatched?.type === 'dispatched') account = dispatched.selected
    for (const event of record.events) {
      if (event.type !== 'observed' || event.usage.state !== 'observed') continue
      tokens += event.usage.inputTokens + event.usage.outputTokens
      if (event.usage.cacheReadTokens !== undefined) {
        cacheReadTokens += event.usage.cacheReadTokens
        splitInputTokens += event.usage.inputTokens
      }
      if (event.usage.costUsd !== undefined) cost = (cost ?? 0) + event.usage.costUsd
    }
  }
  return { account, tokens, cacheReadShare: splitInputTokens === 0 ? null : cacheReadTokens / splitInputTokens, cost }
}

/**
 * The abstract Unix socket name for a pass lock scoped to `$DSH_HOME/system` and one canonical
 * repository; the kernel releases it the instant the process ends (even on SIGKILL).
 */
function passLockName(home: string, canonicalRepository: string): string {
  const systemDir = canonicalRepo(join(home, 'system'))
  return `\0system-carry:${createHash('sha256').update(`${systemDir}\0${canonicalRepository}`).digest('hex')}`
}

export async function acquirePassLock(home: string, repositories: string[]): Promise<{ release(): Promise<void> } | { busy: string }> {
  if (process.platform !== 'linux') throw new Error(`the pass lock needs Linux abstract Unix sockets; this is ${process.platform}`)
  const sorted = [...new Set(repositories.map(canonicalRepo))].sort()
  const servers: Server[] = []
  const release = async () => {
    await Promise.all(servers.map((server) => new Promise<void>((done) => { server.close(() => done()) })))
  }
  for (const repo of sorted) {
    const server = createServer((socket) => socket.destroy())
    try {
      await new Promise<void>((bound, refuse) => {
        server.once('error', refuse)
        server.listen({ path: passLockName(home, repo) }, bound)
      })
      servers.push(server)
    } catch (error) {
      await release()
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return { busy: repo }
      throw error
    }
  }
  return { release }
}

async function submitWork(
  host: HostClient,
  repository: string,
  id: string,
  itemLine: string,
  priorVerdict: string | undefined,
): Promise<string> {
  const workflow = readWorkflowFile(workflowPathFor(repository, itemLine))
  const instructions = `Carry out Item ${id} of STATUS.md: ${itemLine}`
  const created = await host.call('task.new', {
    instructions,
    repository,
    item: id,
    ...(priorVerdict ? { context: [priorVerdict] } : {}),
  })
  const admitted = await host.call('work.submit', { ...workflow, input: created.task, run: false })
  return admitted.id
}

async function runAndMaybeRetry(
  host: HostClient,
  repository: string,
  id: string,
  itemLine: string,
  firstWorkId: string,
  firstMode: 'run' | 'wait',
  priorFailedCount: number,
  includeRepository: boolean,
): Promise<ItemCarryResult> {
  const works: string[] = [firstWorkId]
  const ran: WorkRecord[] = []
  let outcome = 'failed'
  let priorVerdict: string | undefined
  let failedCount = priorFailedCount

  let currentId = firstWorkId
  let mode: 'run' | 'wait' = firstMode
  for (;;) {
    const followed = mode === 'wait' ? await host.wait(currentId) : await host.run(currentId)
    if (typeof followed === 'string') {
      outcome = followed
      break
    }
    ran.push(followed)
    if (isMerged(followed)) {
      outcome = 'merged'
      break
    }
    outcome = followed.state.status
    if (followed.state.status !== 'failed') break
    failedCount += 1
    if (failedCount >= 2) break
    priorVerdict = verdictOf(followed)
    currentId = await submitWork(host, repository, id, itemLine, priorVerdict)
    works.push(currentId)
    mode = 'run'
  }

  const { account, tokens, cacheReadShare, cost } = summaryOf(ran)
  return {
    ...(includeRepository ? { repository } : {}),
    item: id,
    works,
    outcome,
    account,
    tokens,
    cacheReadShare,
    cost,
  }
}

/**
 * Carry one Item of `STATUS.md` as a deterministic caller.
 * Prints one JSON record (`item`, `works`, `outcome`, `account`, `tokens`, `cost`) on stdout and
 * returns 0 only when the Item ended merged or held.
 */
export async function carryItem(host: HostClient, id: string, repoPath: string, io: ItemsIo): Promise<number> {
  const repository = resolve(repoPath)
  const statusLines = await host.call('status', { repository, item: id })
  const itemLine = statusLines.find((line) => !line.startsWith('note: '))
  const skip = (reason: string): number => {
    io.err(`skipping ${id}: ${reason}\n`)
    io.out(`${JSON.stringify({ item: id, works: [], outcome: 'skipped', reason, account: null, tokens: 0, cost: null })}\n`)
    return 1
  }
  if (!itemLine || itemLine.startsWith(`${id} (not in STATUS.md)`)) return skip(`Item ${id} has no line in STATUS.md`)
  const sep = itemLine.indexOf(' - ')
  const statePart = sep >= 0 ? itemLine.slice(sep + 3) : ''
  if (itemLine.startsWith('[x] ') || statePart.startsWith('done')) return skip(`Item ${id} is already done`)
  const blocked = /^todo \((blocked[^)]*)\)$/.exec(statePart)
  if (blocked) return skip(`Item ${id} is ${blocked[1]}`)

  const listed = (await host.call('work.list', {})).filter((w) => w.item === id)
  const records = (await Promise.all(listed.map((w) => host.call('work.show', { workId: w.id })))).filter((r) => sameRepository(r, repository))
  const active = records.find((r) => r.state.status === 'running' || r.state.status === 'held')
  if (active) return skip(`Item ${id} has a ${active.state.status} Work (${active.id})`)
  if (statePart.startsWith('doing: ') && !statePart.startsWith('doing: claimed by ')) {
    return skip(`Item ${id} has a running or held Work`)
  }
  const failed = records.filter((r) => r.state.status === 'failed')
  if (failed.length >= 2) return skip(`Item ${id} already has ${failed.length} failed Works`)

  await host.call('item.claim', { repository, item: id })
  const firstWorkId = await submitWork(host, repository, id, itemLine, failed.length ? verdictOf(failed.at(-1)!) : undefined)
  const result = await runAndMaybeRetry(host, repository, id, itemLine, firstWorkId, 'run', failed.length, false)
  const { cacheReadShare: _share, ...json } = result
  io.out(`${JSON.stringify(json)}\n`)
  return result.outcome === 'merged' || result.outcome === 'held' ? 0 : 1
}

interface ParsedStatusItem {
  repository: string
  canonical: string
  id: string
  key: string
  itemLine: string
  statePart: string
  kind: 'ready' | 'claimed' | 'active'
  claimedBy?: string
}

function parseStatusItems(repository: string, lines: string[]): ParsedStatusItem[] {
  const canonical = canonicalRepo(repository)
  const items: ParsedStatusItem[] = []
  for (const line of lines) {
    if (line.startsWith('note: ') || !line.startsWith('[ ] ')) continue
    const sep = line.indexOf(' - ')
    if (sep < 0) continue
    const head = line.slice(4, sep)
    const id = head.split(/\s+/, 1)[0]
    if (!id) continue
    const statePart = line.slice(sep + 3)
    const key = `${canonical}\0${id}`
    if (statePart === 'todo: nobody') {
      items.push({ repository, canonical, id, key, itemLine: line, statePart, kind: 'ready' })
      continue
    }
    const claimed = /^doing: claimed by (\S+) since /.exec(statePart)
    if (claimed) {
      items.push({ repository, canonical, id, key, itemLine: line, statePart, kind: 'claimed', claimedBy: claimed[1] })
      continue
    }
    if (statePart.startsWith('doing: ')) {
      items.push({ repository, canonical, id, key, itemLine: line, statePart, kind: 'active' })
    }
  }
  return items
}

const NOTIFY_TIMEOUT_MS = 15_000
/** How long a scheduled pass waits for the Host to answer before giving up (ADR-0020 decision 5). */
export const SCHEDULE_HOST_WAIT_MS = 5 * 60_000
const SCHEDULE_HOST_WAIT_INTERVAL_MS = 10_000

function positiveEnvMs(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

const isHostDown = (error: unknown): boolean =>
  error instanceof NotRunning || error instanceof NotAnswering || (error instanceof RpcError && error.code === UPGRADING)

const singleLine = (text: string): string => text.replace(/[\r\n]+/g, ' ').trim()

const formatShare = (share: number | null | undefined): string =>
  share === null || share === undefined ? 'unknown' : `${Math.round(share * 100)}%`

const formatCost = (cost: number | null): string => (cost === null ? 'unknown' : `$${cost.toFixed(2)}`)

function formatPassReport(date: string, repositories: string[], results: ItemCarryResult[], errors: string[]): string {
  const taken = results.filter((r) => r.outcome !== 'skipped')
  const skipped = results.filter((r) => r.outcome === 'skipped')
  const lines: string[] = [
    `# Pass report (${date})`,
    '',
    `Repositories: ${repositories.join(', ')}`,
    '',
    '## Items',
    '',
  ]
  if (taken.length === 0) {
    lines.push('None.')
  } else {
    lines.push(
      '| Item | Repository | Works | Outcome | Account | Tokens | Cache-read share | Cost |',
      '|---|---|---|---|---|---|---|---|',
    )
    for (const r of taken) {
      const works = r.works.join(', ') || '-'
      lines.push(`| ${r.item} | ${r.repository ?? '-'} | ${works} | ${r.outcome} | ${r.account ?? 'unknown'} | ${r.tokens} | ${formatShare(r.cacheReadShare)} | ${formatCost(r.cost)} |`)
    }
  }
  lines.push('', '## Items skipped', '')
  if (skipped.length === 0) {
    lines.push('None.')
  } else {
    for (const r of skipped) {
      const where = r.repository ? ` (${r.repository})` : ''
      lines.push(`- ${r.item}${where}: ${r.reason ?? 'skipped'}`)
    }
  }
  if (errors.length > 0) {
    lines.push('', '## Errors', '')
    for (const error of errors) {
      lines.push(`- ${error}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

function formatNotifyLine(
  date: string,
  repositories: string[],
  results: ItemCarryResult[],
  reportId: string | undefined,
  cause: string | undefined,
): string {
  let merged = 0
  let held = 0
  let failed = 0
  let skipped = 0
  for (const r of results) {
    if (r.outcome === 'merged') merged += 1
    else if (r.outcome === 'held') held += 1
    else if (r.outcome === 'skipped') skipped += 1
    else failed += 1
  }
  const repoNames = repositories.map((r) => basename(r) || r).join(',')
  const base = `${date} ${repoNames}: merged ${merged}, held ${held}, failed ${failed}, skipped ${skipped}, report ${reportId ?? 'none'}`
  return cause ? `${base}, cause: ${singleLine(cause)}` : base
}

async function notifyPass(line: string, io: ItemsIo): Promise<void> {
  const url = process.env.SYSTEM_SCHEDULE_NOTIFY_URL
  if (url) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: line,
        signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      })
      if (!response.ok) {
        io.err(`notifier URL failed: HTTP ${response.status} ${response.statusText}\n`)
      }
    } catch (error) {
      io.err(`notifier URL failed: ${(error as Error).message}\n`)
    }
  }
  const command = process.env.SYSTEM_SCHEDULE_NOTIFY_COMMAND
  if (command) {
    await new Promise<void>((done) => {
      execFile('sh', ['-c', command, '--', line], { timeout: NOTIFY_TIMEOUT_MS }, (error, _stdout, stderr) => {
        if (error) {
          const detail = stderr?.trim() || error.message
          io.err(`notifier command failed: ${detail}\n`)
        }
        done()
      })
    })
  }
}

/**
 * Run one deterministic pass over `repoPaths` in order (ADR-0020 decisions 3, 4, 5):
 * reads `status` of each repository in order, carries every Ready Item with sch-1's rules,
 * runs Works in parallel up to `workers.list` `room` and `--max-parallel`, picks up Items
 * unblocked by merges, adopts Claims and running Works left by a killed pass without
 * submitting anything twice, stores a Markdown report Artifact and prints its ID, fails
 * loudly on Host/status/Item errors, and sends a one-line verdict to the notifier when the
 * pass took an Item or failed.
 */
export async function carryPass(host: HostClient, repoPaths: string[], options: CarryPassOptions, io: ItemsIo): Promise<number> {
  const seenCanon = new Set<string>()
  const repos: string[] = []
  for (const raw of repoPaths.length ? repoPaths : ['.']) {
    const resolved = resolve(raw)
    const canon = canonicalRepo(resolved)
    if (seenCanon.has(canon)) continue
    seenCanon.add(canon)
    repos.push(resolved)
  }

  const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const lock = await acquirePassLock(home, repos)
  if ('busy' in lock) {
    io.err(`another pass is already running for ${lock.busy}\n`)
    return 0
  }

  try {
    const me = operatorId()
    const waitForHostMs = options.waitForHostMs ?? 0
    const waitIntervalMs = options.waitIntervalMs ?? Math.min(SCHEDULE_HOST_WAIT_INTERVAL_MS, waitForHostMs || SCHEDULE_HOST_WAIT_INTERVAL_MS)
    let hostAnswered = false
    const readStatus = async (repository: string): Promise<string[]> => {
      if (hostAnswered || waitForHostMs <= 0) {
        const lines = await host.call('status', { repository })
        hostAnswered = true
        return lines
      }
      const deadline = Date.now() + waitForHostMs
      for (;;) {
        try {
          const lines = await host.call('status', { repository })
          hostAnswered = true
          return lines
        } catch (error) {
          if (!isHostDown(error)) {
            hostAnswered = true
            throw error
          }
          const remaining = deadline - Date.now()
          if (remaining <= 0) throw error
          await new Promise<void>((done) => setTimeout(done, Math.min(waitIntervalMs, remaining)))
        }
      }
    }
    const settled = new Set<string>()
    const inFlight = new Map<string, Promise<{ key: string; result: ItemCarryResult }>>()
    const results: ItemCarryResult[] = []
    const errors: string[] = []
    const unreadableRepos = new Set<string>()
    let hostDown = false
    let fatalCause: string | undefined
    let interrupted = false
    let noRoom = false

    const skipItem = (item: ParsedStatusItem, reason: string) => {
      io.err(`skipping ${item.id}: ${reason}\n`)
      const record: ItemCarryResult = { repository: item.repository, item: item.id, works: [], outcome: 'skipped', reason, account: null, tokens: 0, cost: null }
      results.push(record)
      settled.add(item.key)
    }

    try {
      for (;;) {
        if (!interrupted) {
          const candidates: ParsedStatusItem[] = []
          for (const repository of repos) {
            if (unreadableRepos.has(repository)) continue
            let statusLines: string[]
            try {
              statusLines = await readStatus(repository)
            } catch (error) {
              if (isHostDown(error)) throw error
              const reason = error instanceof Error ? error.message : String(error)
              const msg = `${repository}: status cannot be read: ${reason}`
              errors.push(msg)
              io.err(`${msg}\n`)
              unreadableRepos.add(repository)
              continue
            }
            const missingStatus = statusLines.find((line) => line.startsWith('note: no STATUS.md'))
            if (missingStatus) {
              const msg = `${repository}: status cannot be read: ${missingStatus.slice('note: '.length)}`
              errors.push(msg)
              io.err(`${msg}\n`)
              unreadableRepos.add(repository)
              continue
            }
            for (const item of parseStatusItems(repository, statusLines)) {
              if (inFlight.has(item.key) || settled.has(item.key)) continue
              if (item.kind === 'claimed' && item.claimedBy !== me) continue
              candidates.push(item)
            }
          }

          if (candidates.length > 0) {
            const allWorks = await host.call('work.list', {})
            const shown = new Map<string, WorkRecord>()
            const showWork = async (workId: string): Promise<WorkRecord> => {
              let record = shown.get(workId)
              if (!record) {
                record = await host.call('work.show', { workId })
                shown.set(workId, record)
              }
              return record
            }
            const recordsFor = async (item: ParsedStatusItem): Promise<WorkRecord[]> => {
              const matching = allWorks.filter((w) => w.item === item.id)
              const loaded = await Promise.all(matching.map((w) => showWork(w.id)))
              return loaded.filter((r) => sameRepository(r, item.repository))
            }

            // Re-entry: adopt running Works left by a killed pass without submitting anything twice.
            for (const item of candidates.filter((c) => c.kind === 'active')) {
              const records = await recordsFor(item)
              let active = records.find((r) => r.state.status === 'running' || r.state.status === 'held')
              if (!active) {
                const workId = /^doing: (\S+)/.exec(item.statePart)?.[1]
                if (workId) active = await showWork(workId)
              }
              if (!active || active.state.status !== 'running') {
                settled.add(item.key)
                continue
              }
              const failedCount = records.filter((r) => r.state.status === 'failed').length
              const mode = active.events.length === 1 ? 'run' : 'wait'
              const promise = runAndMaybeRetry(host, item.repository, item.id, item.itemLine, active.id, mode, failedCount, true)
                .then((result) => ({ key: item.key, result }))
              inFlight.set(item.key, promise)
            }

            // Start Ready (and our own claimed-only) Items up to room and --max-parallel.
            const startable = candidates.filter((c) => c.kind === 'ready' || c.kind === 'claimed')
            if (startable.length > 0) {
              const workers = await host.call('workers.list', {})
              const room = workers.room
              const totalAccounts = room && room.accounts > 0 ? room.accounts : workers.registered.length
              const freeFromRoom = room && room.accounts > 0 ? room.free : Math.max(0, totalAccounts - inFlight.size)
              const cap = Math.min(totalAccounts, options.maxParallel ?? Infinity)
              let canStart = Math.max(0, Math.min(freeFromRoom, cap - inFlight.size))
              let deferred = false

              for (const item of startable) {
                const records = await recordsFor(item)
                const active = records.find((r) => r.state.status === 'running' || r.state.status === 'held')
                if (active) {
                  if (active.state.status === 'running') {
                    const failedCount = records.filter((r) => r.state.status === 'failed').length
                    const mode = active.events.length === 1 ? 'run' : 'wait'
                    const promise = runAndMaybeRetry(host, item.repository, item.id, item.itemLine, active.id, mode, failedCount, true)
                      .then((result) => ({ key: item.key, result }))
                    inFlight.set(item.key, promise)
                  } else {
                    settled.add(item.key)
                  }
                  continue
                }
                const failed = records.filter((r) => r.state.status === 'failed')
                if (failed.length >= 2) {
                  skipItem(item, `Item ${item.id} already has ${failed.length} failed Works`)
                  continue
                }
                if (canStart <= 0) {
                  deferred = true
                  break
                }
                try {
                  await host.call('item.claim', { repository: item.repository, item: item.id })
                } catch (error) {
                  if (isHostDown(error)) throw error
                  skipItem(item, (error as Error).message)
                  continue
                }
                const firstWorkId = await submitWork(host, item.repository, item.id, item.itemLine, failed.length ? verdictOf(failed.at(-1)!) : undefined)
                const promise = runAndMaybeRetry(host, item.repository, item.id, item.itemLine, firstWorkId, 'run', failed.length, true)
                  .then((result) => ({ key: item.key, result }))
                inFlight.set(item.key, promise)
                canStart -= 1
              }

              if (deferred && inFlight.size === 0) {
                const msg = `no free Accounts available (0 of ${totalAccounts} free)`
                errors.push(msg)
                io.err(`${msg}; stopping pass\n`)
                noRoom = true
                break
              }
            }
          }
        }

        if (inFlight.size === 0) break
        const finished = await Promise.race(inFlight.values())
        inFlight.delete(finished.key)
        settled.add(finished.key)
        results.push(finished.result)
        if (finished.result.outcome === 'detached' || finished.result.outcome === 'stopped') {
          interrupted = true
        }
      }
    } catch (error) {
      for (const pending of inFlight.values()) void pending.catch(() => {})
      const explained = explain(error, home)
      const message = explained instanceof Error ? explained.message : String(explained)
      fatalCause = message
      errors.push(message)
      io.err(errorLine(explained))
      if (isHostDown(error)) hostDown = true
    }

    const date = (options.now ?? (() => new Date()))().toISOString().slice(0, 10)
    const tookAny = results.some((r) => r.outcome !== 'skipped')
    const anyItemFailed = results.some((r) => r.outcome !== 'merged' && r.outcome !== 'held' && r.outcome !== 'skipped')
    let passFailed = hostDown || errors.length > 0 || noRoom || interrupted || anyItemFailed

    let reportId: string | undefined
    if (!hostDown && (results.length > 0 || errors.length > 0)) {
      const report = formatPassReport(date, repos, results, errors)
      try {
        const envelope = await host.call('artifact.put', {
          data: Buffer.from(report, 'utf8').toString('base64'),
          mediaType: 'text/markdown',
          classification: 'local-private',
        })
        reportId = envelope.id
        io.out(`${reportId}\n`)
      } catch (error) {
        const explained = explain(error, home)
        const message = explained instanceof Error ? explained.message : String(explained)
        io.err(`failed to store pass report: ${message}\n`)
        errors.push(`failed to store pass report: ${message}`)
        passFailed = true
      }
    }

    if (tookAny || passFailed) {
      const cause = fatalCause ?? (errors.length > 0 ? errors.join('; ') : undefined)
      const line = formatNotifyLine(date, repos, results, reportId, cause)
      await notifyPass(line, io)
    }

    return passFailed ? 1 : 0
  } finally {
    await lock.release()
  }
}

/** A sign-in that ends within this long is worth a warning while the Operator can still act (ADR-0020 decision 5). */
const SIGN_IN_WARNING_MS = 3 * 86_400_000

/**
 * The check before a pass (ADR-0020 decision 5): starts nothing, asks `workers.list` once (the Host answers, each
 * repository's status reads, how many Items are Ready, which Accounts can take them) and is silent when all is well.
 * Otherwise it says each finding on stderr, sends one line to the notifier and returns 1.
 */
export async function carryCheck(host: HostClient, repoPaths: string[], options: { now?: () => Date; home?: string }, io: ItemsIo): Promise<number> {
  const repos = repoPaths.map((path) => resolve(path))
  const now = (options.now ?? (() => new Date()))()
  const findings: string[] = []
  let ready = 0
  try {
    const workers = await host.call('workers.list', { repository: repos }) as WorkersView
    const room = workers.room
    for (const entry of room?.ready ?? []) {
      if (entry.error !== undefined) findings.push(`${entry.repository}: status cannot be read: ${singleLine(entry.error)}`)
      else ready += entry.count ?? 0
    }
    if (ready > 0) {
      for (const a of workers.accounts) if (!a.available) findings.push(`${a.ref} is not available: ${singleLine(a.reason)}`)
      if (room && room.free === 0) findings.push(`${ready} Ready Item${ready === 1 ? '' : 's'} and no free Account (${room.free} of ${room.accounts} free)`)
    }
    for (const a of workers.accounts) {
      const ends = a.credentialExpiresAt === undefined ? NaN : Date.parse(a.credentialExpiresAt)
      if (a.available && ends - now.getTime() < SIGN_IN_WARNING_MS) findings.push(`${a.ref}: sign-in ends ${a.credentialExpiresAt}`)
    }
  } catch (error) {
    const explained = explain(error, options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
    findings.push(explained instanceof Error ? singleLine(explained.message) : String(explained))
  }
  if (findings.length === 0) return 0
  for (const finding of findings) io.err(`${finding}\n`)
  const names = repos.map((r) => basename(r) || r).join(',')
  await notifyPass(`${now.toISOString().slice(0, 10)} ${names}: check failed: ${findings.join('; ')}, ready ${ready}`, io)
  return 1
}

/**
 * Run a Schedule file (`system items carry --schedule <file>` or `--check`, ADR-0020 decision 5):
 * waits up to 5 minutes for the Host on a pass (not on `--check`), and turns every failure on the
 * `--schedule` path (unparseable Schedule, Host not answering, uncaught error) into stderr, one
 * notifier line with the cause, and exit 1.
 */
export async function carrySchedule(host: HostClient, file: string, options: CarryScheduleOptions, io: ItemsIo): Promise<number> {
  const home = options.home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const now = options.now ?? (() => new Date())
  try {
    const schedule = readSchedule(file)
    if (options.check) return await carryCheck(host, schedule.repositories, { home, now }, io)
    const waitForHostMs = options.waitForHostMs ?? positiveEnvMs('SYSTEM_SCHEDULE_HOST_WAIT_MS') ?? SCHEDULE_HOST_WAIT_MS
    const waitIntervalMs = options.waitIntervalMs ?? positiveEnvMs('SYSTEM_SCHEDULE_HOST_WAIT_INTERVAL_MS')
    return await carryPass(host, schedule.repositories, { maxParallel: schedule.maxParallel, home, now, waitForHostMs, waitIntervalMs }, io)
  } catch (error) {
    const explained = explain(error, home)
    const message = explained instanceof Error ? explained.message : String(explained)
    io.err(errorLine(explained))
    const date = now().toISOString().slice(0, 10)
    const name = basename(file, '.yaml') || file
    const line = options.check
      ? `${date} ${name}: check failed: ${singleLine(message)}`
      : `${date} ${name}: pass failed, cause: ${singleLine(message)}`
    await notifyPass(line, io)
    return 1
  }
}
