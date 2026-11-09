# @system/app tests

Unit tests run with `node --test` (Node 24 strips the types). They use fake
hosts only; the booted profile is covered by the [smoke test](../../../tests/README.md).

- `doctor.test.ts`: the doctor over fake hosts;
- `service.test.ts`: the pure decisions of `bin/system`: the Node choice, the
  unit text and when init installs it, and the supervisor loop (restarts
  only on exit 75);
- `wait.test.ts`: `system work wait`: the exit codes (the worst outcome across
  several Works), `--any`, that held counts as done, the timeout (exit 4), over
  fake hosts;
- `remote.test.ts`: following a Work reconnects once after the Host closed the
  connection for an upgrade.
- `mcp.test.ts`: `system mcp` through the SDK's MCP client, spawned against a
  Host served in the test process; the resources, subscriptions and notices, and that a client
  that was away reads `work.events` from its cursor and misses nothing.
