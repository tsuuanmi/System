/**
 * The provider's own account ID of an agent account, read from files on disk without a model turn. Each reader
 * returns the one ID field or `undefined` (a missing file, bad JSON, a missing field); it never throws and never
 * returns or logs another field, so no token leaves the file.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

const field = (value: unknown, key: string): unknown => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined)
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined)

/** Claude Code: `<dir>/.claude.json` `oauthAccount.accountUuid`, else `oauthAccount.emailAddress`. */
export function readClaudeAccountId(dir: string): string | undefined {
  const oauth = field(readJson(join(dir, '.claude.json')), 'oauthAccount')
  return text(field(oauth, 'accountUuid')) ?? text(field(oauth, 'emailAddress'))
}

/** Codex: `<codexHome>/auth.json` `tokens.account_id`. */
export function readCodexAccountId(codexHome: string): string | undefined {
  return text(field(field(readJson(join(codexHome, 'auth.json')), 'tokens'), 'account_id'))
}
