/**
 * The `ratchets` check (Item ratchet-1): the number of `as unknown as` casts in packages/<name>/src may only fall. A checked-in
 * baseline (.system/ratchets/unknown-casts.txt) holds the count: growth fails; a fall fails until `--prune` lowers the baseline
 * (so the gain is recorded and cannot be spent again); `--prune` never raises it. Usage: node tools/check-ratchets.ts [--prune]
 * Run from the repository root; it counts the files git tracks (or has staged), so build output and node_modules are not read.
 *
 * Adapted from Orca's ratchet-baseline.mjs (https://github.com/stablyai/orca, commit 196cf89), MIT License,
 * Copyright (c) Lovecast Inc. Permission is granted, free of charge, to use, copy, modify and distribute it, provided this
 * notice and the MIT License text of that project are included in copies or substantial portions.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const BASELINE = '.system/ratchets/unknown-casts.txt'
const PATTERN = /\bas unknown as\b/g
const prune = process.argv.includes('--prune')

function count(): number {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'packages/*/src/**'], { encoding: 'utf8' }).split('\0').filter((file) => /\.(ts|tsx|mts|cts)$/.test(file))
  let total = 0
  for (const file of files) total += readFileSync(file, 'utf8').match(PATTERN)?.length ?? 0
  return total
}

function fail(message: string): never {
  console.error(`ratchets: ${message}`)
  process.exit(1)
}

let recorded: number
try {
  recorded = Number(readFileSync(BASELINE, 'utf8').trim())
  if (!Number.isInteger(recorded) || recorded < 0) throw new Error('not a count')
} catch (error) {
  fail(`cannot read the baseline ${BASELINE}: ${(error as Error).message}`)
}
const now = count()
if (now > recorded) fail(`\`as unknown as\` casts grew from ${recorded} to ${now} (${BASELINE}); remove the new casts, the baseline never rises`)
if (now < recorded) {
  if (!prune) fail(`\`as unknown as\` casts fell from ${recorded} to ${now}; run \`node tools/check-ratchets.ts --prune\` and commit ${BASELINE}`)
  writeFileSync(BASELINE, `${now}\n`)
  console.log(`ratchets: baseline lowered from ${recorded} to ${now}`)
} else {
  console.log(`ratchets: \`as unknown as\` casts ${now}, at the baseline`)
}
