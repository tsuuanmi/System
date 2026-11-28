/**
 * Prints the `bin` directory of the Node the repository asks for (`nodeBin` of @system/runtime-cli, the one the checks step and Workers use, fl-3),
 * for tools/hooks/pre-push. Usage: node tools/node-bin.ts [worktree]. Prints nothing when the repository names no Node; exits 1 with the reason when none installed fits.
 */
import { resolve } from 'node:path'
import { nodeBin } from '../packages/runtime-cli/src/node.ts'

try {
  const bin = nodeBin(resolve(process.argv[2] ?? '.'))
  if (bin) console.log(bin)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
