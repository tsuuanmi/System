// Deliberately tiny ACP v1 fake agent for offline Rust SDK integration tests.
// The Rust bridge, not this fixture, owns the client protocol implementation.
import { createInterface } from 'node:readline'

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
let pendingPrompt
for await (const line of lines) {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  } else if (request.method === 'session/new') {
    send({ id: request.id, result: { sessionId: 'mock-session' } })
  } else if (request.method === 'session/prompt') {
    if (process.env.MOCK_PERMISSION === '1') {
      pendingPrompt = request.id
      send({
        id: 'permission-1',
        method: 'session/request_permission',
        params: {
          sessionId: 'mock-session',
          toolCall: { toolCallId: 'tool-1', title: 'Run a command' },
          options: [
            { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
          ],
        },
      })
    } else {
      send({ id: request.id, result: { stopReason: process.env.MOCK_STOP_REASON ?? 'end_turn' } })
    }
  } else if (request.id === 'permission-1' && pendingPrompt !== undefined) {
    send({ id: pendingPrompt, result: { stopReason: 'end_turn' } })
    pendingPrompt = undefined
  }
}
