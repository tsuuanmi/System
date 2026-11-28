/**
 * rt-4 (ADR-0018 decisions 3 to 5): the profile migration. The rows `agents` and `web-worker` became `runtime-cli` and `runtime-web`, and the
 * `web` Accounts moved from the first to the second. A patch of an old id would match no row and be skipped with a warning, and a `runtime: web`
 * Account under the CLI row would be refused as an unknown Runtime; so a profile that has either is refused at Host start, with the rows to write
 * instead. The operator's profile is never rewritten (dsh-doc `configuration.md`).
 */
import { readFileSync } from 'node:fs'
import { parse, stringify } from 'yaml'

type Patch = Record<string, unknown>
type Account = Record<string, unknown>

const OLD_CLI = 'agents'
const OLD_WEB = 'web-worker'
const CLI = 'runtime-cli'
const WEB = 'runtime-web'
const GUIDE = 'docs/operations/accounts-and-workers.md, "Moving the Accounts to runtime-cli and runtime-web"'

const isRecord = (value: unknown): value is Patch => typeof value === 'object' && value !== null && !Array.isArray(value)
const accountsOf = (patch: Patch): Account[] => (isRecord(patch.config) && Array.isArray(patch.config.accounts) ? patch.config.accounts.filter(isRecord) : [])
const isWebAccount = (account: Account): boolean => account.runtime === 'web' || (typeof account.ref === 'string' && account.ref.startsWith('web/'))

/** The patches of a profile, in the order its layers apply, as the rows the refusal prints; `undefined` when none needs to move. */
export function profileMigration(patches: readonly unknown[]): string | undefined {
  const rows = patches.filter(isRecord)
  const oldRows = [...new Set(rows.map((row) => row.id).filter((id): id is string => id === OLD_CLI || id === OLD_WEB))]
  const misplaced = rows.filter((row) => (row.id === OLD_CLI || row.id === CLI) && !row.insert).flatMap((row) => accountsOf(row).filter(isWebAccount)).map((account) => String(account.ref))
  if (!oldRows.length && !misplaced.length) return undefined

  // The CLI row: each patch of `agents` or `runtime-cli` with the web Accounts taken out; the web row: the `web-worker` patches, plus those Accounts.
  const cliRows: Patch[] = []
  const webFields: Patch = {}
  const webAccounts: Account[] = []
  let webConfig: Patch = {}
  for (const row of rows) {
    if (row.insert || (row.id !== OLD_CLI && row.id !== CLI && row.id !== OLD_WEB && row.id !== WEB)) continue
    if (row.id === OLD_WEB || row.id === WEB) {
      const { id: _id, config, ...rest } = row
      Object.assign(webFields, rest)
      if (isRecord(config)) {
        // The wait of the old hand-over (`registerWaitSeconds`) is gone with it.
        const { registerWaitSeconds: _wait, accounts: _accounts, ...kept } = config
        webConfig = { ...webConfig, ...kept }
        webAccounts.push(...accountsOf(row))
      }
      continue
    }
    const { config, ...rest } = row
    const moved = accountsOf(row).filter(isWebAccount)
    webAccounts.push(...moved)
    if (!isRecord(config)) { cliRows.push({ ...rest, id: CLI }); continue }
    // `webWorkerWaitSeconds` waited for the web row's service: gone.
    const { webWorkerWaitSeconds: _wait, accounts, ...kept } = config
    const rest_ = Array.isArray(accounts) ? { accounts: accounts.filter((a) => !(isRecord(a) && isWebAccount(a))) } : {}
    cliRows.push({ ...rest, id: CLI, config: { ...kept, ...rest_ } })
  }
  const out: Patch[] = cliRows
  if (webAccounts.length || Object.keys(webFields).length || Object.keys(webConfig).length) {
    // A web Account was served only while the old web-worker row was on: the new row says so.
    out.push({ id: WEB, ...(webAccounts.length && webFields.disabled === undefined ? { disabled: false } : {}), ...webFields, ...(webAccounts.length || Object.keys(webConfig).length ? { config: { ...webConfig, ...(webAccounts.length ? { accounts: webAccounts } : {}) } } : {}) })
  }

  const why = [
    ...(oldRows.length ? [`the profile patches ${oldRows.map((id) => `the row ${id}`).join(' and ')}, which ${oldRows.length > 1 ? 'are' : 'is'} now named ${oldRows.map((id) => (id === OLD_CLI ? CLI : WEB)).join(' and ')}; a patch of an old id matches no row`] : []),
    ...(misplaced.length ? [`the row ${CLI} lists the web Account${misplaced.length > 1 ? 's' : ''} ${misplaced.join(', ')}; a web Account belongs to the row ${WEB}`] : []),
  ]
  return [
    `the profile is not migrated to the rows of ADR-0018: ${why.join('; and ')}.\nWrite these rows instead (System never rewrites a profile):`,
    stringify(out).trimEnd(),
    `Each Runtime owns its Accounts in its own row. How to move: ${GUIDE}.`,
  ].join('\n\n')
}

/** `profileMigration` over the patch files of a profile (a file that is missing or does not read is dsh's to report) and the overlays dsh parsed from the command line. */
export function profileMigrationOfFiles(files: readonly string[], overlays: readonly unknown[] = []): string | undefined {
  const read = (file: string): unknown[] => {
    try { const parsed: unknown = parse(readFileSync(file, 'utf8')); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
  }
  return profileMigration([...files.flatMap(read), ...overlays])
}
