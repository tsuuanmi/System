/**
 * Old capability names still written in a config file (nm-3). The pairs are `CAPABILITY_ALIASES` of nm-1, read from there and nowhere else here.
 * A text scan, not a parse: it must name the line of the file the operator edits, and a profile patch is not a Workflow.
 */
import { CAPABILITY_ALIASES } from '@system/work'

export interface OldName {
  /** The old name as written. */
  old: string
  /** The name it stands for now. */
  now: string
  file: string
  /** 1-based line of the file. */
  line: number
}

/** The keys that hold capability names: a Worker's grant or a step's need (a list), a step's preference or a verifier (one name). */
const KEY = /^\s*(?:-\s+)?(capabilities|prefer|capability)\s*:\s*(.*)$/
const ITEM = /^\s*-\s+(.*)$/
const names = (text: string): string[] => text.replace(/#.*$/, '').split(/[\s,[\]'"]+/).filter(Boolean)

/** Every old capability name in `text`, in file order. */
export function findOldNames(text: string, file: string): OldName[] {
  const found: OldName[] = []
  const note = (words: string[], line: number): void => {
    for (const old of words) if (Object.hasOwn(CAPABILITY_ALIASES, old)) found.push({ old, now: CAPABILITY_ALIASES[old]!, file, line })
  }
  let block = false
  text.split('\n').forEach((raw, i) => {
    const key = KEY.exec(raw)
    if (key) {
      const rest = names(key[2]!)
      block = key[1] === 'capabilities' && rest.length === 0
      note(rest, i + 1)
      return
    }
    const item = block ? ITEM.exec(raw) : null
    if (item) note(names(item[1]!), i + 1)
    else if (raw.trim() !== '' && !raw.trim().startsWith('#')) block = false
  })
  return found
}

/** `old → now`, with where to change it. */
export const describeOldName = (n: OldName): string => `${n.old} → ${n.now}  (${n.file}:${n.line}: change it to ${n.now})`
