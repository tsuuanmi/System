import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NotRunning, type Client } from '../../host/lib/index.js'
import { remoteHost } from '../src/remote.ts'

const client = (call: (method: string) => Promise<unknown>): Client => ({ call: (method) => call(method), onNotice: () => {}, close: () => {} })

test('following a Work reconnects once when the Host closes the connection for an upgrade', { timeout: 20_000 }, async () => {
  let opened = 0
  const open = async (): Promise<Client> => {
    opened++
    return opened === 1
      ? client(async () => { throw new NotRunning('the Host closed the connection (it stopped or was restarted)') })
      : client(async (method) => (method === 'work.events' ? { events: [{ seq: 3 }], status: 'succeeded' } : { id: 'work:x', state: { status: 'succeeded' } }))
  }
  const followed = await remoteHost({ open, err: () => {} }).work().wait('work:x')
  assert.equal(opened, 2)
  assert.equal((followed as { id: string }).id, 'work:x')
})

test('a Host that is still away after the reconnect is the error', { timeout: 20_000 }, async () => {
  const open = async (): Promise<Client> => client(async () => { throw new NotRunning('the Host is not running') })
  await assert.rejects(remoteHost({ open, err: () => {} }).work().wait('work:x'), /not running/)
})
