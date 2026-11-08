// Offline ACP v1 agent fixture. Deliberately minimal: the official SDK is the client.
import { createInterface } from 'node:readline'
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
let pendingPrompt
for await (const line of lines) {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    if (process.env.MOCK_HANG === 'initialize') continue
    send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  } else if (request.method === 'session/new') {
    send({ id: request.id, result: { sessionId: 'mock-acp-session' } })
  } else if (request.method === 'session/prompt') {
    if (process.env.MOCK_PERMISSION === '1') {
      pendingPrompt = request.id
      send({
        id: 'permission-1',
        method: 'session/request_permission',
        params: {
          sessionId: 'mock-acp-session',
          toolCall: { toolCallId: 'tool-1', title: 'Run command', kind: 'execute' },
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
    // A rejection still lets the remote agent return end_turn:
    // the System Worker MUST reject that as a successful Attempt.
    send({ id: pendingPrompt, result: { stopReason: 'end_turn' } })
    pendingPrompt = undefined
  }
}
