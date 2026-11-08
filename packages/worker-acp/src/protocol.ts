/** System-owned bridge IPC mapping, not an ACP wire implementation.
 * The official Rust ACP SDK handles initialize/session/prompt requests. */
import type { Progress } from '@system/work'
import type { Workspace } from '@system/worker-execution'

export interface Invocation {
  argv: string[]
  env: Record<string, string>
}

/** Forward only the minimal environment and an account's explicitly selected auth. */
export function acpInvocation(
  bridge: string,
  ws: Workspace,
  promptFile: string,
  agentCommand: string,
  agentArgs: string[],
  token?: string,
  codexHome?: string,
): Invocation {
  const env: Record<string, string> = { HOME: ws.home, TMPDIR: ws.home }
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ']) if (process.env[key]) env[key] = process.env[key]!
  return {
    argv: [bridge, '--agent', agentCommand, '--args-json', JSON.stringify(agentArgs), '--prompt-file', promptFile],
    env: {
      ...env,
      ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
      ...(codexHome ? { CODEX_HOME: codexHome } : {}),
    },
  }
}

export interface AcpParsed {
  ok: boolean
  message: string
}

/** A denied permission or ambiguous/unmatched report never counts as success. */
export function parseAcp(stdout: string): AcpParsed {
  let denied = false
  let result: { ok?: unknown; stopReason?: unknown } | undefined
  let results = 0
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event?.type === 'acp.permission_denied') denied = true
      if (event?.type === 'acp.result') {
        results += 1
        result = event
      }
    } catch { /* untrusted non-protocol lines never establish completion */ }
  }
  if (denied) return { ok: false, message: 'ACP permission was denied; no automatic approval' }
  if (results !== 1 || !result) return { ok: false, message: 'ACP bridge has no unambiguous completed-turn result' }
  const ok = result.ok === true && result.stopReason === 'EndTurn'
  return { ok, message: ok ? 'ACP v1 EndTurn' : `ACP stopped without success: ${String(result.stopReason ?? 'unknown')}` }
}

export function acpProgress(): (stdout: string) => Progress {
  let seen = 0
  let stage = ''
  return (stdout) => {
    const end = stdout.lastIndexOf('\n') + 1
    const fresh = stdout.slice(seen, Math.max(seen, end))
    seen = Math.max(seen, end)
    for (const line of fresh.split('\n')) {
      try {
        const event = JSON.parse(line)
        if (typeof event?.type === 'string' && ['acp.initialized', 'acp.session_ready', 'acp.permission_denied', 'acp.result'].includes(event.type)) stage = event.type
      } catch { /* incomplete line waits */ }
    }
    return stage ? { stage } : {}
  }
}
