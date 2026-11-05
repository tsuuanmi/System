/**
 * `system doctor`: which rows of the System composition are mounted, and
 * whether durable storage answers. Required rows missing make the report fail
 * closed; an optional row may be disabled by config without failing it.
 */

/** A row of the System bundle, the service it provides, and whether System needs it. */
export interface RowProbe {
  id: string
  service: string
  required: boolean
  purpose: string
}

/** The rows of packages/bundle/cordis.patch.yml that provide services. */
export const ROWS: readonly RowProbe[] = [
  { id: 'storage', service: 'storage', required: true, purpose: 'storage hub' },
  { id: 'storage-sqlite', service: 'storage.backend.sqlite', required: true, purpose: 'SQLite backend' },
  { id: 'storage-domain', service: 'storageDomain', required: true, purpose: 'Work and Artifact records' },
  { id: 'attachment-local', service: 'attachments', required: true, purpose: 'Artifact bytes' },
  { id: 'subprocess', service: 'subprocess', required: true, purpose: 'Worker and verifier processes' },
  { id: 'credentials', service: 'credentials', required: false, purpose: 'model and GitHub key references' },
]

/** The storage backend Work records must use (ADR-0004 decision 9). */
export const REQUIRED_BACKEND = 'sqlite'

export interface RowStatus extends RowProbe {
  mounted: boolean
}

export interface StorageStatus {
  ok: boolean
  backend: string
  detail: string
}

export interface DoctorReport {
  ok: boolean
  versions: { node: string; dsh: string }
  rows: RowStatus[]
  storage: StorageStatus
  problems: string[]
}

/** What the doctor reads from the running host; a seam so tests need no host. */
export interface DoctorHost {
  hasService(name: string): boolean
  dshVersion(): string
  probeStorage(): Promise<StorageStatus>
}

export async function runDoctor(host: DoctorHost): Promise<DoctorReport> {
  const rows = ROWS.map((row) => ({ ...row, mounted: host.hasService(row.service) }))
  const problems: string[] = []
  for (const row of rows) {
    if (row.required && !row.mounted) problems.push(`required row ${row.id} (${row.purpose}) is not mounted: service ${row.service} is unavailable`)
  }
  const storageMounted = rows.every((row) => !row.service.startsWith('storage') || row.mounted)
  const storage = storageMounted
    ? await host.probeStorage()
    : { ok: false, backend: REQUIRED_BACKEND, detail: 'not probed: storage rows are not mounted' }
  if (storageMounted && !storage.ok) problems.push(`storage probe failed: ${storage.detail}`)
  return {
    ok: problems.length === 0,
    versions: { node: process.version, dsh: host.dshVersion() },
    rows,
    storage,
    problems,
  }
}

export function formatReport(report: DoctorReport): string {
  const lines = [`system doctor: ${report.ok ? 'ok' : 'FAILED'}`, `  node ${report.versions.node}, dsh ${report.versions.dsh}`]
  for (const row of report.rows) {
    const state = row.mounted ? 'mounted' : row.required ? 'MISSING' : 'disabled'
    lines.push(`  ${row.id.padEnd(17)} ${state.padEnd(8)} ${row.required ? 'required' : 'optional'}  ${row.purpose}`)
  }
  lines.push(`  storage probe     ${report.storage.ok ? 'ok' : 'failed'}  backend ${report.storage.backend}: ${report.storage.detail}`)
  for (const problem of report.problems) lines.push(`  problem: ${problem}`)
  return `${lines.join('\n')}\n`
}
