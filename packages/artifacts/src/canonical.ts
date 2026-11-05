/**
 * Canonical JSON and SHA-256 content addresses.
 *
 * Ported from System 1 (tsuuanmi/system, commit f199a27,
 * packages/libs/src/canonical.ts) with the owner's permission; behavior is
 * unchanged, `hashDomain` is new.
 */
import { createHash } from 'node:crypto'

/** A content address: `sha256:` followed by 64 lowercase hex characters. */
export type ContentId = `sha256:${string}`

export const CONTENT_ID_RE = /^sha256:[0-9a-f]{64}$/

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit (as RFC 8785 specifies),
 * no insignificant whitespace, `undefined` object members omitted. Non-finite
 * numbers and non-JSON values throw, because a hash over them would not be
 * reproducible.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number ${value}`)
    return JSON.stringify(value)
  }
  // Array.from visits holes in sparse arrays (map would skip them), serializing them as null.
  if (Array.isArray(value)) return `[${Array.from(value, (item: unknown) => canonicalJson(item ?? null)).join(',')}]`
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonicalJson: only plain objects are allowed')
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`
  }
  throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`)
}

/** SHA-256 content address of raw bytes or text. */
export function sha256(data: string | Uint8Array): ContentId {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

/**
 * Content address of a JSON value under a hash domain: the domain tag and a
 * newline precede the canonical form, so two domains never share an address
 * for the same value.
 */
export function hashDomain(domain: string, value: unknown): ContentId {
  if (!/^[a-z][a-z0-9.]*\/v[0-9]+$/.test(domain)) throw new TypeError(`hashDomain: invalid domain tag ${domain}`)
  return sha256(`${domain}\n${canonicalJson(value)}`)
}
