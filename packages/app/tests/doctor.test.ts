import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ROWS, formatReport, runDoctor, type DoctorHost, type HostStatus, type StorageStatus } from '../src/doctor.ts'

const okStorage: StorageStatus = { ok: true, backend: 'sqlite', detail: 'durable write and read back' }

function host(missing: string[] = [], storage: StorageStatus = okStorage, answering: HostStatus = { answering: true, detail: 'version 0.0.0, pid 42' }): DoctorHost & { probes: number } {
  const fake = {
    probes: 0,
    hasService: (name: string) => !missing.includes(name),
    dshVersion: () => '0.2.2-rc.1',
    probeHost: async () => answering,
    probeStorage: async () => {
      fake.probes += 1
      return storage
    },
  }
  return fake
}

test('every row mounted and storage answering is ok', async () => {
  const report = await runDoctor(host())
  assert.equal(report.ok, true)
  assert.deepEqual(report.problems, [])
  assert.equal(report.rows.length, ROWS.length)
  assert.match(formatReport(report), /^system doctor: ok/)
})

test('a disabled optional row is reported but does not fail', async () => {
  const report = await runDoctor(host(['credentials']))
  assert.equal(report.ok, true)
  assert.equal(report.rows.find((row) => row.id === 'credentials')?.mounted, false)
  assert.match(formatReport(report), /credentials\s+disabled/)
})

test('a missing required row fails closed and names the row', async () => {
  const report = await runDoctor(host(['subprocess']))
  assert.equal(report.ok, false)
  assert.equal(report.problems.length, 1)
  assert.match(report.problems[0]!, /required row subprocess/)
  assert.match(formatReport(report), /subprocess\s+MISSING/)
})

test('storage is not probed when a storage row is missing', async () => {
  const fake = host(['storage.backend.sqlite'])
  const report = await runDoctor(fake)
  assert.equal(fake.probes, 0)
  assert.equal(report.ok, false)
  assert.equal(report.storage.ok, false)
})

test('a failed storage probe fails the report', async () => {
  const report = await runDoctor(host([], { ok: false, backend: 'sqlite', detail: 'read back a different record' }))
  assert.equal(report.ok, false)
  assert.deepEqual(report.problems, ['storage probe failed: read back a different record'])
})

test('the report says whether a Host answers; none answering does not fail it', async () => {
  const up = await runDoctor(host())
  assert.deepEqual(up.host, { answering: true, detail: 'version 0.0.0, pid 42' })
  assert.match(formatReport(up), /host\s+answering: version 0.0.0, pid 42/)
  const down = await runDoctor(host([], okStorage, { answering: false, detail: 'the System Host is not running for /h: systemctl --user start system (or run: system host)' }))
  assert.equal(down.ok, true)
  assert.match(formatReport(down), /host\s+not answering: the System Host is not running for \/h/)
})
