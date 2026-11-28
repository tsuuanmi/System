/**
 * `system doctor --store`: a read-only walk of every Work record and every Artifact of the home. It writes, repairs and
 * deletes nothing. Reading a Work through its record schema re-folds its state; each Artifact ID its events name must be
 * stored; each stored Artifact is verified by `Artifacts.verify` (a blob read in full, inline content re-hashed).
 */
import type { Artifacts } from '@system/artifacts/contract'
import type { WorkRecord, WorkTable } from '@system/work'

export interface StoreReport {
  ok: boolean
  works: number
  artifacts: number
  blobs: number
  bytes: number
  problems: string[]
}

interface StoreSources {
  works: Pick<WorkTable, 'keys' | 'get'>
  artifacts: Pick<Artifacts, 'ids' | 'get' | 'verify'>
}

/** Every Artifact ID a Work's events and folded state name, with the place that names it. */
function namedArtifacts(record: WorkRecord): { id: string; role: string }[] {
  const named: { id: string; role: string }[] = []
  const add = (role: string, id: string | undefined) => { if (id) named.push({ id, role }) }
  const addAll = (role: string, ids: Record<string, string> | readonly string[] | undefined) => {
    for (const [key, id] of Object.entries(ids ?? {})) add(`${role} ${key}`, id)
  }
  for (const event of record.events) {
    const at = `event ${event.seq} (${event.type})`
    switch (event.type) {
      case 'admitted': add(`${at} spec`, event.specId); add(`${at} input`, event.input); add(`${at} goal`, event.goal); addAll(`${at} criteria`, event.criteria); break
      case 'dispatched': addAll(`${at} input`, event.inputs); break
      case 'observed': addAll(`${at} output`, event.outputs); addAll(`${at} partial`, event.partial); add(`${at} log`, event.log); add(`${at} unchangedAfter`, event.unchangedAfter); break
      case 'verified': add(`${at} subject`, event.subject); add(`${at} verdict`, event.verdictId); addAll(`${at} evidence`, event.evidence); add(`${at} rerunOf`, event.rerunOf); break
      case 'reopened': add(`${at} failure`, event.failure); add(`${at} base`, event.base); add(`${at} previous`, event.previous); break
      case 'effect-intended': add(`${at} subject`, event.subject); break
      case 'effect-observed': add(`${at} held`, event.held); break
      case 'terminal': addAll(`${at} result`, event.results); break
      default: break
    }
  }
  const state = record.state
  add('pinned spec', state.specId)
  add('input', state.input)
  addAll('pinned criteria', state.criteria)
  addAll('result', state.results)
  return named
}

export async function checkStore({ works, artifacts }: StoreSources): Promise<StoreReport> {
  const report: StoreReport = { ok: true, works: 0, artifacts: 0, blobs: 0, bytes: 0, problems: [] }
  const problem = (text: string) => { report.problems.push(text) }
  const present = new Map<string, boolean>()
  const isStored = (id: string): boolean => {
    let stored = present.get(id)
    if (stored === undefined) {
      try { stored = artifacts.get(id).state === 'stored' } catch { stored = false }
      present.set(id, stored)
    }
    return stored
  }
  for (const key of [...works.keys()]) {
    report.works += 1
    let record: WorkRecord | undefined
    try {
      record = works.get(key)
    } catch (error) {
      problem(`Work ${key}: the record does not read: ${(error as Error).message}`)
      continue
    }
    if (!record) { problem(`Work ${key}: the record is not stored`); continue }
    const seen = new Set<string>()
    for (const { id, role } of namedArtifacts(record)) {
      if (seen.has(id) || isStored(id)) continue
      seen.add(id)
      problem(`Work ${key}: Artifact ${id} (${role}) is not stored`)
    }
  }
  for (const id of artifacts.ids()) {
    report.artifacts += 1
    try {
      const checked = await artifacts.verify(id)
      if ('problem' in checked) { problem(`Artifact ${id}: ${checked.problem}`); continue }
      if (checked.blob) report.blobs += 1
      report.bytes += checked.bytes
    } catch (error) {
      problem(`Artifact ${id}: ${(error as Error).message}`)
    }
  }
  report.ok = report.problems.length === 0
  return report
}

export function formatStoreReport(report: StoreReport): string {
  const lines = [`system doctor --store: ${report.ok ? 'ok' : 'FAILED'}`]
  for (const [label, n] of [['works', report.works], ['artifacts', report.artifacts], ['blobs', report.blobs], ['bytes read', report.bytes]] as const) lines.push(`  ${label.padEnd(11)} ${n}`)
  for (const text of report.problems) lines.push(`  problem: ${text}`)
  return `${lines.join('\n')}\n`
}
