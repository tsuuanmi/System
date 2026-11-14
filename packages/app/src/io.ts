/**
 * The terminal side of the CLI, shared by the Host-side app row and the thin
 * client: who is calling, secrets and confirmations from a person, and how an
 * error reaches the operator.
 */
import { userInfo } from 'node:os'
import type { Caller } from '@system/work'
// By path, not by package: declaring @system/host here would change the lockfile.
import { NotAnswering, NotRunning } from '../../host/lib/index.js'

/** The operator a CLI call acts for (ADR-0004 decision 1). */
export function operatorId(): string {
  return process.env.SYSTEM_OPERATOR_ID || userInfo().username
}

/** Who made this CLI call (ADR-0011): a human only at a terminal; SYSTEM_CALLER=agent may lower that, nothing raises it. */
export function caller(): Caller {
  const type = process.env.SYSTEM_CALLER === 'agent' || !process.stdin.isTTY ? 'agent' : 'human'
  return { type, operatorId: operatorId() }
}

/** Read a secret: hidden on a terminal, or the whole of piped stdin less its final newline. */
export async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  }
  process.stderr.write(prompt)
  stdin.setRawMode(true)
  stdin.resume()
  let value = ''
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString('utf8')) {
          if (char === '\r' || char === '\n') { stdin.off('data', onData); resolve(value); return }
          if (char === '\u0003') { stdin.off('data', onData); reject(new Error('cancelled')); return }
          if (char === '\u007f') value = value.slice(0, -1)
          else value += char
        }
      }
      stdin.on('data', onData)
    })
  } finally {
    stdin.setRawMode(false)
    stdin.pause()
    process.stderr.write('\n')
  }
}

/** One typed line from a human at the terminal; anything else is refused (ADR-0004 decision 3). */
export async function confirmHuman(prompt: string, expected: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('this decision needs a human at a terminal: stdin is not a terminal, so the caller may be an agent (ADR-0004 decision 3)')
  }
  const { createInterface } = await import('node:readline/promises')
  const lines = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const typed = (await lines.question(prompt)).trim()
    if (typed !== expected) throw new Error('the confirmation did not match; nothing was decided')
  } finally {
    lines.close()
  }
  return operatorId()
}

/** What an operator reads when a command fails: one line, and the stack only with SYSTEM_DEBUG=1. */
export function errorLine(error: unknown): string {
  const failure = error instanceof Error ? error : new Error(String(error))
  return process.env.SYSTEM_DEBUG === '1' && failure.stack ? `system: ${failure.stack}\n` : `system: ${failure.message}\n`
}

/** The operator-facing error for what the transport reports, or the error itself. */
export function explain(error: unknown, home: string): unknown {
  if (error instanceof NotRunning) return new Error(`the System Host is not running for ${home}: systemctl --user start system (or run: system host)`, { cause: error })
  if (error instanceof NotAnswering) return new Error(`the System Host for ${home} is not answering (${error.message}): see docs/operations/runbook.md, "The Host is not answering"`, { cause: error })
  return error
}
