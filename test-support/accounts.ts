/** Fake provider homes for tests: a temp directory with the one file an account's ID is read from. Never the real ~/.claude or ~/.dsh. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function tempDir(prefix = 'account-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** `<dir>/.claude.json` as `{ oauthAccount }`; a fresh directory when none is given. */
export function fakeClaudeHome(dir: string | undefined, oauthAccount: { accountUuid?: string; emailAddress?: string }): string {
  const home = dir ?? tempDir('claude-')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount, accessToken: 'SECRET-ACCESS' }))
  return home
}

/** `<dir>/auth.json` with `tokens.account_id` (when given) beside tokens that must never be read; a fresh directory when none is given. */
export function fakeCodexHome(dir: string | undefined, accountId?: string): string {
  const home = dir ?? tempDir('codex-')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { ...(accountId ? { account_id: accountId } : {}), access_token: 'SECRET-ACCESS', refresh_token: 'SECRET-REFRESH' } }))
  return home
}
