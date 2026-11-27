/**
 * Item redact-1 (RES-0016): no secret reaches a stored Artifact from an attempt. One redaction function, applied by the attempt
 * lifecycle (lifecycle.ts) to the log before it is bounded and stored, to a failure reason and to the attempt summary, and the
 * Account's own token is masked by value. Never applied to an Artifact already stored (they are immutable).
 *
 * The patterns (provider keys, Bearer tokens, URL user-info, .env-style lines, credential assignments, key-name blocklist) are
 * ported from Orca's src/shared/observability/redactor.ts and credential-assignment-redaction.ts at commit 196cf89
 * (https://github.com/stablyai/orca), under its MIT licence:
 *
 *   MIT License
 *   Copyright (c) 2026 Lovecast Inc.
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation
 *   files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy,
 *   modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions: The above copyright notice and this permission notice
 *   shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY
 *   OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
 *   PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
 *   THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * Differences from Orca: no span/attribute API; the key-name blocklist masks a string value (the key stays, so a log line keeps its shape);
 * a JSON line of a log is redacted by its string values (so an environment printed in a tool result, whose newlines are escaped in the line, is
 * seen as lines), and is rewritten only when a value changed.
 */

const STANDALONE_BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi

// Specific providers first so sk-ant- keeps its Anthropic tag.
const PROVIDER_PATTERNS: { tag: string; re: RegExp }[] = [
  { tag: 'anthropic-key', re: /sk-ant-[a-zA-Z0-9_-]{40,}/g },
  { tag: 'openai-key', re: /sk-(?:proj-)?[a-zA-Z0-9_-]{32,}/g },
  { tag: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { tag: 'github-token', re: /github_pat_[A-Za-z0-9_]{22,}/g },
  { tag: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/g },
  { tag: 'aws-secret-access-key', re: /aws_secret_access_key\s*[:=]\s*[A-Za-z0-9/+=]{40}/gi },
  { tag: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { tag: 'slack-token', re: /xox[baprsoe]-[A-Za-z0-9-]{10,}/g },
  // Complete blocks independently; an unfinished block loses its suffix.
  { tag: 'pem', re: /-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|(?![\s\S]))/g },
]

// Both user:pass@ and token@, keeping host and path.
const URL_USERINFO = /(https?:\/\/)([^/@\s]+)@/g

// A whole .env-style line (NAME=value), empty values skipped.
const ENV_LINE = /^[ \t]*([A-Z_][A-Z0-9_]*)[ \t]*=[ \t]*\S.*$/gm

const CREDENTIAL_ASSIGNMENT = /(?<![\w-])(?:\\?["'])?([\w-]+)(?:\\?["'])?\s*[:=]\s*/g
const CREDENTIAL_NAME = /(?:apikey|token|secret|password|bearer|authorization|privkey|privatekey|secretkey)$/i
const BARE_CREDENTIAL_NAME = /^(?:api[-_]?key|token|secret|password|bearer|authorization)$/i
const AUTH_SCHEME = /(?:Basic|Bearer|Token)[^\S\r\n\u2028\u2029]+/iy
const LINE_END = /[\r\n\u2028\u2029]/

function credentialValueSpan(input: string, start: number): { end: number; quoteSize: number; closed: boolean } {
  const escaped = input[start] === '\\' && /["']/.test(input[start + 1] ?? '')
  const quote = input[start + (escaped ? 1 : 0)]
  if (quote !== '"' && quote !== "'") {
    AUTH_SCHEME.lastIndex = start
    let end = AUTH_SCHEME.test(input) ? AUTH_SCHEME.lastIndex : start
    while (end < input.length && !/\s/.test(input[end]!)) end++
    return { end, quoteSize: 0, closed: false }
  }
  const quoteSize = escaped ? 2 : 1
  let end = start + quoteSize
  while (end < input.length && !LINE_END.test(input[end]!)) {
    let slashes = 0
    while (input[end] === '\\') { slashes++; end++ }
    if (input[end] === quote && (escaped ? slashes % 4 === 1 : slashes % 2 === 0)) return { end: end + 1, quoteSize, closed: true }
    if (end < input.length && !LINE_END.test(input[end]!)) end++
  }
  return { end, quoteSize, closed: false }
}

function redactCredentialAssignments(input: string): string {
  const parts: string[] = []
  let copiedThrough = 0
  CREDENTIAL_ASSIGNMENT.lastIndex = 0
  for (let match = CREDENTIAL_ASSIGNMENT.exec(input); match; match = CREDENTIAL_ASSIGNMENT.exec(input)) {
    if (!CREDENTIAL_NAME.test(match[1]!.replace(/[-_]/g, ''))) continue
    const start = CREDENTIAL_ASSIGNMENT.lastIndex
    const span = credentialValueSpan(input, start)
    const quote = input.slice(start, start + span.quoteSize)
    const preserveLabel = !BARE_CREDENTIAL_NAME.test(match[1]!)
    parts.push(input.slice(copiedThrough, match.index), preserveLabel ? input.slice(match.index, start) + quote : '', '[redacted:labeled-kv]', preserveLabel && span.closed ? quote : '')
    copiedThrough = span.end
    CREDENTIAL_ASSIGNMENT.lastIndex = span.end
  }
  if (parts.length === 0) return input
  parts.push(input.slice(copiedThrough))
  return parts.join('')
}

/** Mask each of `secrets` (an Account's own token) by value, in its plain and its JSON-escaped form; a value under 3 characters is ignored. */
export function maskValues(text: string, secrets: readonly (string | undefined)[], marker = '[redacted]'): string {
  let out = text
  for (const secret of secrets) {
    if (!secret || secret.length < 3) continue
    out = out.split(secret).join(marker)
    const json = JSON.stringify(secret).slice(1, -1)
    if (json !== secret) out = out.split(json).join(marker)
  }
  return out
}

/** Redact the secrets in one piece of text; idempotent. `secrets` are masked by value first. */
export function redactString(input: string, secrets: readonly (string | undefined)[] = []): string {
  if (typeof input !== 'string' || input.length === 0) return input
  let out = maskValues(input, secrets, '[redacted:account-token]')
  for (const { tag, re } of PROVIDER_PATTERNS) out = out.replace(re, `[redacted:${tag}]`)
  out = redactCredentialAssignments(out).replace(STANDALONE_BEARER, '[redacted:labeled-kv]')
  out = out.replace(URL_USERINFO, '$1[redacted]@')
  return out.replace(ENV_LINE, '$1=[redacted:env-value]')
}

/** Keys whose string value is a secret whatever it looks like. `apiKeySource` names where a key came from (`none`), not a key. */
function isSecretKey(key: string): boolean {
  if (key === 'apiKeySource') return false
  const k = key.toLowerCase()
  const normalized = k.replace(/[^a-z0-9]+/g, '')
  return ['env', 'environment', 'env_vars', 'cookie', 'set-cookie', 'bearer', 'headers.authorization'].includes(k)
    || /\b(api[-_]?key|token|secret|password|bearer|authorization|private[-_]?key)\b/i.test(key)
    || /(apikey|token|secret|password|authorization|bearer|privkey|privatekey)/.test(normalized)
}

/** `value` with every string redacted (a string under a secret key wholly); the same object when nothing changed. */
export function redactValue<T>(value: T, secrets: readonly (string | undefined)[] = []): T {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return key !== undefined && v.length > 0 && isSecretKey(key) ? '[redacted:key]' : redactString(v, secrets)
    if (Array.isArray(v)) {
      const next = v.map((e) => walk(e, key))
      return next.some((e, i) => e !== v[i]) ? next : v
    }
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      let changed = false
      const out: Record<string, unknown> = {}
      for (const [k, e] of Object.entries(v)) { out[k] = walk(e, k); if (out[k] !== e) changed = true }
      return changed ? out : v
    }
    return v
  }
  return walk(value) as T
}

const PEM_BEGIN = /-----BEGIN [A-Z ]+-----/g
const PEM_END = /-----END [A-Z ]+-----/

/** Whether the line's last PEM header has no END after it, so the block goes on in the next lines. */
function pemOpensAtEnd(line: string): boolean {
  let last = -1
  for (const m of line.matchAll(PEM_BEGIN)) last = m.index + m[0].length
  return last >= 0 && !PEM_END.test(line.slice(last))
}

function redactLogLine(line: string, secrets: readonly (string | undefined)[]): string {
  const head = line.trimStart()[0]
  if (head === '{' || head === '[') {
    try {
      const event: unknown = JSON.parse(line)
      const clean = redactValue(event, secrets)
      // A value of the text the parse did not change may still hold a secret across keys (a cut line is handled below).
      return clean === event ? maskValues(line, secrets, '[redacted:account-token]') : JSON.stringify(clean)
    } catch { /* a line cut by the stream's end, or not JSON: as text */ }
  }
  return redactString(line, secrets)
}

/** An attempt's log (lines of stream-json or text): a JSON line is redacted by its values and rewritten only when one changed, any other line as text; a PEM block over several text lines is dropped from after its header to its END (or the log's end), the text after END kept. */
export function redactLog(log: string, secrets: readonly (string | undefined)[] = []): string {
  let inPem = false
  const out: string[] = []
  for (const raw of log.split('\n')) {
    let line = raw
    if (inPem) {
      const end = PEM_END.exec(line)
      if (!end) continue
      inPem = false
      line = line.slice(end.index + end[0].length)
    }
    const head = line.trimStart()[0]
    if (head !== '{' && head !== '[') inPem = pemOpensAtEnd(line)
    out.push(redactLogLine(line, secrets))
  }
  return out.join('\n')
}
