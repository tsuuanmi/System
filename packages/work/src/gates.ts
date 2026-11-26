/**
 * Gate paths (Item gate-1, RES-0018): a change touching one is held for the Operator's Approval of that commit after
 * its checks pass. The list is configuration: the `gates:` list of `.system/checks.yaml`, read from the base commit
 * (like the checks), so a list the Work itself changes does not apply to it.
 */
import { matchesGlob } from 'node:path'
import { parse } from 'yaml'

/** The `gates:` globs of a `.system/checks.yaml` text (`!` excludes, the last pattern matching a file decides, as `paths` of a check); empty when it has none or is not readable. */
export function gatesOf(text: string): string[] {
  try {
    const gates = (parse(text) as { gates?: unknown } | null)?.gates
    return Array.isArray(gates) ? gates.filter((g): g is string => typeof g === 'string' && g.length > 0) : []
  } catch {
    return []
  }
}

/** Of `files` (relative to the repository), those a gate glob selects. */
export function gatedFiles(files: readonly string[], gates: readonly string[]): string[] {
  return files.filter((file) => gates.reduce((in_, glob) => glob.startsWith('!') ? (matchesGlob(file, glob.slice(1)) ? false : in_) : (matchesGlob(file, glob) ? true : in_), false))
}
