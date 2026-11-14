import assert from 'node:assert/strict'
import { test } from 'node:test'
import { caller } from '../src/io.ts'

/** `caller()` with SYSTEM_CALLER and a stdin that is or is not a terminal. */
function callerWith(declared: string | undefined, isTTY: boolean) {
  const saved = [process.env.SYSTEM_CALLER, Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')] as const
  if (declared === undefined) delete process.env.SYSTEM_CALLER
  else process.env.SYSTEM_CALLER = declared
  Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true })
  try {
    return caller().type
  } finally {
    if (saved[0] === undefined) delete process.env.SYSTEM_CALLER
    else process.env.SYSTEM_CALLER = saved[0]
    if (saved[1]) Object.defineProperty(process.stdin, 'isTTY', saved[1])
    else delete (process.stdin as { isTTY?: boolean }).isTTY
  }
}

test('SYSTEM_CALLER=human is ignored when stdin is not a terminal (ADR-0011)', () => {
  assert.equal(callerWith('human', false), 'agent')
})

test('a terminal is a human, and SYSTEM_CALLER=agent still declares an agent', () => {
  assert.equal(callerWith(undefined, true), 'human')
  assert.equal(callerWith('human', true), 'human')
  assert.equal(callerWith('agent', true), 'agent')
  assert.equal(callerWith(undefined, false), 'agent')
})
