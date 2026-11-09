/** Start a headed Chrome on a private Xvfb, open a page and stop both; exits 1 with the reason when it cannot. Run by headed.ts. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launch, webDefaults } from '../packages/web-worker/src/chatgpt.ts'
import { startXvfb } from '../packages/web-worker/src/display.ts'

const dir = mkdtempSync(join(tmpdir(), 'system-probe-'))
const display = await startXvfb()
try {
  const context = await launch({ ...webDefaults(join(dir, 'profile')), executablePath: process.env.CHROME_FOR_PROBE, timeouts: { load: 15, answer: 15, stable: 1 } }, display)
  await (context.pages()[0] ?? await context.newPage()).goto('about:blank')
  await context.close()
} catch (error) {
  process.stderr.write(`${(error as Error).message.split('\n')[0]}\n`)
  process.exitCode = 1
} finally {
  await display.stop()
  rmSync(dir, { recursive: true, force: true })
}
