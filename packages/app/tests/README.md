# @system/app tests

Unit tests run with `node --test` (Node 24 strips the types). They use fake
hosts only; the booted profile is covered by the [smoke test](../../../tests/README.md).

- `doctor.test.ts`: the doctor over fake hosts;
- `service.test.ts`: the pure decisions of `bin/system`: the Node choice, the
  unit text and when init installs it.
