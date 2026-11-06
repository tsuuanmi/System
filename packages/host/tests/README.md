# @system/host tests

Over a real Unix socket:
- `transport.test.ts`: handshake, framing limits, error codes, out-of-order
  answers, and the client's "not running" and timeout errors;
- `operations.test.ts`: the operation table with fake Workers. Every method
  round-trips; agents are refused every `agent: false` row; a repeated
  `commandId` gives one Work; `work.events` follows a Work to the state
  `work.show` has; a closed client leaves its Work running;
- `process.test.ts`: `serveHost`: the socket, a stale file, one that is not a socket, a path too long, the stop;
- `api.test.ts`: the README's API reference equals the one generated from the
  table.
