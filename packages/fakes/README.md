# @system/fakes

The `fakes` row: a scripted Worker (`fake-worker`) and verifier
(`fake-verifier`) for offline tests. It is **disabled** in the
[System bundle](../bundle/README.md); a profile patch turns it on:

```yaml
- id: fakes
  disabled: false
  config:
    workers: [code-write, code.develop, research, web-search, tier.standard]
    verifiers: [code.required-checks, research.citation-check]
```

The Worker stores one `fake-output@1` Artifact per output slot, with the
step's inputs as its inputs. The verifier accepts `fake-output`, pins a
`fake-criteria@1` Artifact, stores one evidence Artifact per verdict, and
returns `pass` unless told otherwise. Turn the `verifiers` row off beside it:
both offer the same verifier capabilities. The fake publisher (`effects:
[git.publish]`) accepts `fake-output` and keeps what it published in
`$DSH_HOME/system/fake-effects.json`, so reconciliation works across hosts;
turn the `effects` row off beside it too.

Test hooks, read from the environment:

| Variable | Effect |
|---|---|
| `SYSTEM_FAKE_LOG=<file>` | append `<workId> <stepId> <attemptId>` per Worker call |
| `SYSTEM_FAKE_CRASH_AT=<stepId>` | SIGKILL the process hosting the Worker (`system host`) when that step is dispatched |
| `SYSTEM_FAKE_FAIL=<stepId>` | that step's Worker reports failure |
| `SYSTEM_FAKE_SLEEP_AT=<stepId>` | that step's Worker waits until cancelled, then reports `cancelled` with one partial output |
| `SYSTEM_FAKE_HOLD_AT=<stepId>`, `SYSTEM_FAKE_HOLD_FILE=<file>` | that step's Worker waits until the file exists, then succeeds; cancelled meanwhile, it reports `cancelled` as with `SLEEP_AT` |
| `SYSTEM_FAKE_VERDICT=<verdict>` | every verdict (`pass`, `fail`, `inconclusive`, `error`) |

Source: [src/index.ts](src/index.ts).
