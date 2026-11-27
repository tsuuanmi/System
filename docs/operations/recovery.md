---
type: operations
status: active
reviewed: 2026-11-26
summary: Backing up, reading logs, and what to do when the Host or a check fails.
covers: [packages/app/src/cli.ts, packages/app/src/io.ts]
related: [operations/runbook, architecture/host]
---

# Recovery

Part of the [runbook](runbook.md).

## Back up and restore

The store is the only place that knows an Item is done. Copy, as one set:

- `$DSH_HOME/system/state.sqlite` with its `-wal` and `-shm` files, or a copy
  made with the Host stopped;
- the attachment store the profile configures (`$DSH_HOME/attachments`);
- the rest of `$DSH_HOME/system` (Account profiles);
- the repositories, at the same absolute paths: a git-tree Artifact names its
  repository by absolute path, and the pinned refs live in them.

To restore, stop the Host, put those back (same paths), start the Host, and end
with the check:

```
system doctor --store
```

It walks every Work and Artifact read-only (beside a running Host too): each
record folds, each Artifact a Work names is stored, each blob reads in full and
matches its digest. It prints the counts and one line per problem, and exits 0
only when there is none. It repairs nothing.

## Logs

`journalctl --user -u system` (add `-f` to follow).

## Host not running

The CLI prints one line and exits 1 when nothing answers at
`$DSH_HOME/system/host.sock` (or `operator/host.sock` for an operator command):

```
system: the System Host is not running for <home>: systemctl --user start system (or run: system host)
```

1. `systemctl --user status system`: is it `active`? If not, start it.
2. If it failed, read `journalctl --user -u system -e`. A missing `claude`,
   `codex` or `git` is a `PATH` captured at init that no longer holds: run
   `system init` again from a shell that has them.
3. `Node >=24.9.0` errors: `bin/system` runs the newest Node 24 under
   `~/.nvm/versions/node/` by itself; with none, install one (`nvm install 24`).
4. `another Host already runs for <home>`: one is running, perhaps one in a
   terminal. Stop it; there is one Host per home.

## The Host is not answering

The message `system: the System Host for <home> is not answering (...)` points to a
section of the runbook; it is this one, on this page.

The socket accepts connections but a call got no answer in 10 seconds. A call
that changes something (every write: `submit`, `run`, `retry`, `cancel`,
`approve`, `task new`, `intent new`, `claim`, ...) carries a fresh
`commandId` and is sent once more with the same one, so the Host does it once:
look at `system work list` before sending it again yourself.

Every command but `system work wait` fails at once with this. `system work wait`
keeps waiting with a backoff; after 10 minutes unreachable (or its `--timeout`)
it exits **6**, never a success, and the Works may still be running: run it
again or `system work list`. Its exits are in the
[app README](../../packages/app/README.md).

1. `systemctl --user status system` and `journalctl --user -u system -e`: is
   the Host alive, and busy or stuck?
2. `system doctor` boots DSH beside the Host and says whether it answers.
3. If it is stuck, `systemctl --user restart system`; what that loses and what runs again is in
   [Stop, restart, status](install-and-update.md#stop-restart-status).

## A check the base fails too

A required check that fails on a change is run again on its base commit. When
the base fails it too, the failing checks are run once more on the change and on
the base (sc-13), because a loaded machine fails checks the change did not
break: a pass on the change's re-run gives `pass`, a pass on the base's gives
`fail`. Only when they still fail on both is the `checks` verdict `inconclusive`
(`<check>: the base fails it too`, evidence of all the runs) and the Work
**held** before `publish`. `system work show <id>` shows the base runs;
`system approve <work> --reason ...` lets it publish and merge, `system deny
<work> --reason ...` fails it.

## A check that fails again on the same change

When a failing check reopens `implement` and `implement` changes nothing, the
check runs once more on that same change (`retry.rerunUnchanged`, sc-9;
[the vocabulary](../architecture/workflow-composition.md#the-implemented-vocabulary-systemworkflowv1)).
If the second run passes, the Work goes on and `system work show <id>` notes
the check as flaky. If it fails again, the verdict is `inconclusive` with both
runs as evidence and the Work is **held**: `system approve <work>` lets it
go on, `system deny <work> --reason ...` fails it, and `system work retry <id> --step <verify
step>` asks the check again (a human at a terminal types the Work's short code; an agent or
script cannot, even over `host.sock`). This re-run (sc-9) is separate from the verifier's own one re-run of an
inconclusive verdict (sc-13, [above](#a-check-the-base-fails-too)).

## Errors

An error is one line, `system: <message>`, never a stack. `SYSTEM_DEBUG=1`
prints the stack as well.
