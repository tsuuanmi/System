import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fixture } from '../../../test-support/fixture.ts'
import type { Services } from '../src/operations.ts'
import { serveHost, socketPath } from '../src/process.ts'

// A socket path is limited to about 100 bytes, and tmpdir() may be longer.
const base = mkdtempSync('/tmp/sh-')
after(() => rmSync(base, { recursive: true, force: true }))
let count = 0
const fresh = () => { const path = join(base, `h${count++}`); mkdirSync(path); return path }

test('something that is not a socket at the path is not removed', { timeout: 60_000 }, async () => {
  const home = fresh()
  mkdirSync(join(home, 'system'))
  writeFileSync(socketPath(home), 'mine')
  const host = await fixture().startHost(home)
  await assert.rejects(serveHost({ host, home, services: {} as Services, log: () => {} }), /EADDRINUSE/)
  assert.equal(existsSync(socketPath(home)), true)
  await host.close()
})

test('a home whose socket path is too long for a Unix socket is refused with the fix', { timeout: 60_000 }, async () => {
  const home = join(fresh(), 'x'.repeat(100))
  mkdirSync(home)
  const host = await fixture().startHost(home)
  await assert.rejects(serveHost({ host, home, services: {} as Services, log: () => {} }), /too long for a Unix socket.*shorter DSH_HOME/)
  await host.close()
})

test('a Host whose process outlives its stop is made to exit with its status, naming what kept it alive', async () => {
  const { exitWithin } = await import('../src/process.ts')
  // Something left open after the stop, as a timer of a row or an idle connection may be.
  const lingering = setInterval(() => {}, 1000)
  const lines: string[] = []
  try {
    const exited = new Promise<number>((resolve) => {
      const timer = exitWithin(75, { graceMs: 20, log: (line) => lines.push(line), exit: resolve })
      assert.equal(timer.hasRef(), false, 'the backstop itself never keeps the process alive')
    })
    assert.equal(await exited, 75)
    assert.match(lines.join('\n'), /still running 0\.02 s after it stopped; exiting 75; open: .*Timeout/)
  } finally {
    clearInterval(lingering)
  }
})
