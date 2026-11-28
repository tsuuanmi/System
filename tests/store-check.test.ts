/**
 * `system doctor --store` through the real `bin/system` on a throwaway home: a Work run by the fake Worker, then
 * blobs damaged on disk. The Host stays running throughout (the walk is read-only beside it).
 */
import assert from 'node:assert/strict'
import { chmodSync, readdirSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { after, before, test } from 'node:test'
import { systemCli } from '../test-support/cli.ts'
import { withFakes } from '../test-support/fakes.ts'

const cli = systemCli('system-store-check')
const home = cli.home
const system = (...args: string[]) => cli.run(args)

/** The file holding the bytes of a stored blob, by its attachment ID (what the attachment store reads and verifies). */
const objectOf = (id: string): string => {
  const shown = JSON.parse(system('artifact', 'show', id).stdout) as { envelope: { blob: { attachmentId: string } } }
  const hex = shown.envelope.blob.attachmentId.slice('sha256:'.length)
  return join(home, 'attachments', 'v1', 'file-objects', hex.slice(0, 2), hex)
}

const put = (name: string, text: string): string => {
  const file = join(home, name)
  writeFileSync(file, text)
  const ran = system('artifact', 'put', file)
  assert.equal(ran.status, 0, ran.stderr)
  return ran.stdout.trim()
}

before(async () => {
  assert.equal(system('init').status, 0)
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), withFakes({ workers: ['repo.write'] }))
  await cli.start()
})

after(async () => {
  await cli.stop()
  rmSync(home, { recursive: true, force: true })
})

test('--help documents --store and that it runs beside a running Host', () => {
  const ran = system('doctor', '--help')
  assert.equal(ran.status, 0, ran.stderr)
  assert.match(ran.stdout, /--store/)
  assert.match(ran.stdout, /running Host/)
})

test('doctor --store counts a healthy store, then names each damaged blob', { timeout: 300_000 }, () => {
  const submitted = system('work', 'submit', '--capability', 'repo.write')
  assert.equal(submitted.status, 0, submitted.stderr)
  const truncated = put('a.txt', 'the bytes of the first blob, which will be cut short')
  const deleted = put('b.txt', 'the bytes of the second blob, which will be deleted')
  put('c.txt', 'a third blob that stays whole')

  const ok = system('doctor', '--store')
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  assert.match(ok.stdout, /^system doctor --store: ok/m)
  assert.match(ok.stdout, /works\s+1\b/)
  assert.match(ok.stdout, /blobs\s+[3-9]\b/)
  assert.match(ok.stdout, /bytes read\s+[1-9]\d*/)
  const json = JSON.parse(system('doctor', '--store', '--json').stdout) as { ok: boolean; works: number; artifacts: number; blobs: number; bytes: number; problems: string[] }
  assert.deepEqual([json.ok, json.works, json.problems], [true, 1, []])
  assert.ok(json.artifacts > json.blobs && json.bytes > 0)

  const before = statSync(objectOf(truncated)).size
  chmodSync(objectOf(truncated), 0o644)
  truncateSync(objectOf(truncated), before - 5)
  // The object and its named alias are hard links of one file: deleting the blob removes both.
  const object = objectOf(deleted)
  unlinkSync(object)
  rmSync(join(object.replace('file-objects', 'files'), '..', basename(object)), { recursive: true, force: true })
  const bad = system('doctor', '--store')
  assert.equal(bad.status, 1, bad.stdout)
  assert.match(bad.stdout, /^system doctor --store: FAILED/m)
  assert.match(bad.stdout, new RegExp(`problem: Artifact ${truncated}: .+`))
  assert.match(bad.stdout, new RegExp(`problem: Artifact ${deleted}: .+`))
  assert.equal(bad.stdout.split('\n').filter((l) => l.includes('problem:')).length, 2, bad.stdout)
  assert.ok(readdirSync(join(home, 'attachments')).length > 0)
})

test('doctor without --store is unchanged: no store walk, the probe still runs', () => {
  const ran = system('doctor')
  assert.equal(ran.status, 0, ran.stderr)
  assert.match(ran.stdout, /storage probe\s+ok/)
  assert.doesNotMatch(ran.stdout, /works|blobs/)
})
