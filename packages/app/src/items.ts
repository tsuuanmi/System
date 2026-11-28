/**
 * Deterministic caller for carrying out Items of `STATUS.md` (ADR-0020 decisions 1, 2, 4):
 * no model call anywhere; fixed rules for skipping, claiming, storing the Task, picking the
 * Workflow, submitting, waiting, retrying once with the failed Work's verdict, and reporting.
 */
import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { codeRoot } from '@system/host'
import type { WorkEvent, WorkRecord } from '@system/work'
import { readWorkflowFile, type HostClient } from './remote.ts'

export interface ItemsIo {
  out(text: string): void
  err(text: string): void
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

function summaryOf(records: WorkRecord[]): { account: string | null; tokens: number; cost: number | null } {
  let account: string | null = null
  let tokens = 0
  let cost: number | null = null
  for (const record of records) {
    const dispatched = record.events.findLast((e) => e.type === 'dispatched' && e.executor === 'worker')
    if (dispatched?.type === 'dispatched') account = dispatched.selected
    for (const event of record.events) {
      if (event.type !== 'observed' || event.usage.state !== 'observed') continue
      tokens += event.usage.inputTokens + event.usage.outputTokens
      if (event.usage.costUsd !== undefined) cost = (cost ?? 0) + event.usage.costUsd
    }
  }
  return { account, tokens, cost }
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
  const workflow = readWorkflowFile(workflowPathFor(repository, itemLine))
  const instructions = `Carry out Item ${id} of STATUS.md: ${itemLine}`
  const works: string[] = []
  const ran: WorkRecord[] = []
  let priorVerdict = failed.length ? verdictOf(failed.at(-1)!) : undefined
  let outcome = 'failed'
  const maxAttempts = 2 - failed.length
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const created = await host.call('task.new', {
      instructions,
      repository,
      item: id,
      ...(priorVerdict ? { context: [priorVerdict] } : {}),
    })
    const admitted = await host.call('work.submit', { ...workflow, input: created.task, run: false })
    works.push(admitted.id)
    const followed = await host.run(admitted.id)
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
    priorVerdict = verdictOf(followed)
  }

  const { account, tokens, cost } = summaryOf(ran)
  io.out(`${JSON.stringify({ item: id, works, outcome, account, tokens, cost })}\n`)
  return outcome === 'merged' || outcome === 'held' ? 0 : 1
}
