/**
 * Reading a `STATUS.md` (Item df-3, cm-4): no imports, so a check can run it before anything is installed
 * (`tools/check-status.ts`).
 */

/** An Item's ID in a repository's STATUS.md, such as `df-3` or `dna-13`. */
export const ITEM_ID = /^[a-z][a-z0-9-]*-[0-9]+$/

export interface Item {
  id: string
  /** Without the `(after: ...)` marker. */
  title: string
  done: boolean
  /** The IDs of the Items this one comes after, from `(after: id, id)` at the end of its line; absent when it has none. */
  after?: string[]
}

export interface ParsedStatus {
  aim: string[]
  items: Item[]
  /** One line for each malformed line: `line N: why`; the Item dependencies add `cycle: a -> b -> a`. */
  problems: string[]
}

/** `STATUS.md` is about this long at most; details go elsewhere, as links. */
const MAX_LINES = 100
const MAX_AIM = 3
/** The marker ends the Item line: `(after: cm-1, cm-3)`. Without the colon it is title text. */
const AFTER = /^(.*?)\s*\(after:\s*([^)]*)\)$/

/** The cycles of the `after` relation (each once, as `a -> b -> a`), found from the Items in file order. */
function cycles(items: Item[]): string[][] {
  const by = new Map(items.map((i) => [i.id, i]))
  const found: string[][] = []
  const seen = new Set<string>()
  const walk = (id: string, path: string[]): void => {
    const at = path.indexOf(id)
    if (at >= 0) { found.push([...path.slice(at), id]); return }
    if (seen.has(id)) return
    seen.add(id)
    for (const next of by.get(id)?.after ?? []) if (by.has(next)) walk(next, [...path, id])
  }
  for (const item of items) walk(item.id, [])
  return found
}

/** The IDs of Items that come after themselves, directly or through others. */
function cyclic(items: Item[]): Set<string> {
  const by = new Map(items.map((i) => [i.id, i]))
  const result = new Set<string>()
  for (const item of items) {
    const seen = new Set<string>()
    const stack = [...item.after ?? []]
    while (stack.length) {
      const id = stack.pop()!
      if (id === item.id) { result.add(id); break }
      if (!seen.has(id)) { seen.add(id); stack.push(...by.get(id)?.after ?? []) }
    }
  }
  return result
}

/**
 * Why an Item that is not done is Blocked, or undefined when it is Ready: `cycle`, or the IDs of the Items it comes after
 * that are not done (an ID with no line is never done). `done` says which listed Items are done.
 */
export function blockedBy(items: Item[], item: Item, done: (id: string) => boolean): 'cycle' | string[] | undefined {
  if (!item.after?.length) return undefined
  if (cyclic(items).has(item.id)) return 'cycle'
  const open = item.after.filter((id) => !done(id))
  return open.length ? open : undefined
}

/** The text a Blocked Item's state carries: `blocked: cycle` or `blocked by cm-1, cm-3`. */
export const blockedText = (why: 'cycle' | string[]): string => (why === 'cycle' ? 'blocked: cycle' : `blocked by ${why.join(', ')}`)

/**
 * Read a `STATUS.md` leniently: what is well-formed is used, and each line that is not gets a reason. With `strict`, any
 * problem (a bad line, a duplicate ID, an unknown ID after `after:`, a cycle) throws, naming all of them.
 */
export function parseStatus(text: string, options: { strict?: boolean } = {}): ParsedStatus {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const aim: string[] = []
  const items: Item[] = []
  const at = new Map<string, number>()
  const problems: string[] = []
  let inAim = false
  for (const [n, raw] of lines.entries()) {
    const line = raw.trimEnd()
    const here = `line ${n + 1}`
    const heading = /^Aim:\s*(.*)$/.exec(line)
    if (heading && !aim.length) {
      inAim = true
      if (heading[1]) aim.push(heading[1])
      continue
    }
    if (inAim && line && !/^[#*-]/.test(line)) {
      aim.push(line.trim())
      continue
    }
    inAim = false
    if (!/^[-*]\s/.test(line)) continue
    const item = /^[-*] \[([ xX])\] (\S+)(?:\s+(.*))?$/.exec(line)
    if (!item) {
      problems.push(/^[-*] \[/.test(line) ? `${here}: not an Item line: the box is [ ] or [x], then an ID and a title` : `${here}: not an Item line (- [ ] <id> <title>)`)
    } else if (!ITEM_ID.test(item[2]!)) {
      problems.push(`${here}: ${item[2]} is not an Item ID (lower case, ending in -<number>, such as df-3)`)
    } else if (items.some((i) => i.id === item[2])) {
      problems.push(`${here}: Item ${item[2]} is listed already`)
    } else {
      const marker = AFTER.exec(item[3]?.trim() ?? '')
      const after = marker ? [...new Set(marker[2]!.split(',').map((id) => id.trim()).filter(Boolean))] : []
      const title = marker ? marker[1]!.trim() : item[3]?.trim() ?? ''
      if (marker && !after.length) problems.push(`${here}: Item ${item[2]} has an empty (after: ) list`)
      items.push({ id: item[2]!, title, done: item[1] !== ' ', ...(after.length ? { after } : {}) })
      at.set(item[2]!, n + 1)
      if (!title) problems.push(`${here}: Item ${item[2]} has no title`)
    }
  }
  for (const item of items) for (const id of item.after ?? []) {
    if (!at.has(id)) problems.push(`line ${at.get(item.id)}: Item ${item.id} comes after unknown id ${id}`)
  }
  for (const cycle of cycles(items)) problems.push(`cycle: ${cycle.join(' -> ')}`)
  if (!aim.length) problems.push('no Aim: line')
  if (aim.length > MAX_AIM) problems.push(`the aim has ${aim.length} lines; keep it to ${MAX_AIM}`)
  if (lines.length > MAX_LINES) problems.push(`STATUS.md has ${lines.length} lines; keep it to about ${MAX_LINES} and link the details`)
  if (options.strict && problems.length) throw new Error(`STATUS.md has ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map((p) => `  ${p}`).join('\n')}`)
  return { aim, items, problems }
}
