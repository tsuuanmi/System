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
