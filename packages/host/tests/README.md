# @system/host tests

Over a real Unix socket, with a Host on the in-memory stand-ins of
[test-support](../../../test-support/README.md):
- `transport.test.ts`: handshake, framing limits, error codes, out-of-order
  answers, and the client's "not running" and timeout errors;
- `operations.test.ts`: the operation table with fake Workers. Every method
  round-trips (the table is iterated, so a new row is covered); agents are refused every `agent: false` row; a repeated
  `commandId` gives one Work; `work.events` follows a Work to the state
  `work.show` has; a closed client leaves its Work running;
- `operations.test.ts` also: `work.watch` sends one `work.changed` on finishing and on a hold, `work.unwatch`,
  a closed connection and a client that missed the notice;
- `process.test.ts`: `serveHost` refuses a path that is not a socket and one that is too long (the running process is in [tests](../../../tests/README.md));
- `api.test.ts`: the README's API reference equals the one generated from the
  table; `SYSTEM_DOCS_WRITE=1 corepack pnpm test` rewrites it.
