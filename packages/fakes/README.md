# @system/fakes

The `fakes` row: a scripted Worker (`fake-worker`) and verifier
(`fake-verifier`) for offline tests. It is **disabled** in the
[System bundle](../bundle/README.md); a profile patch turns it on:

```yaml
- id: fakes
  disabled: false
  config:
    workers: [code-write, research, web-search]
    verifiers: [code.required-checks, research.citation-check]
```

The Worker stores one `fake-output@1` Artifact per output slot, with the
step's inputs as its inputs. The verifier returns `pass` unless told otherwise.

Test hooks, read from the environment:

| Variable | Effect |
|---|---|
| `SYSTEM_FAKE_LOG=<file>` | append `<workId> <stepId> <attemptId>` per Worker call |
| `SYSTEM_FAKE_CRASH_AT=<stepId>` | SIGKILL the host when that step is dispatched |
| `SYSTEM_FAKE_FAIL=<stepId>` | that step's Worker reports failure |
| `SYSTEM_FAKE_VERDICT=<verdict>` | every verdict (`pass`, `fail`, `inconclusive`, `error`) |

Source: [src/index.ts](src/index.ts).
