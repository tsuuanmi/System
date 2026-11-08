---
id: ADR-0007
type: decision
status: accepted
date: 2026-11-06
summary: Replace one short-lived DSH host per CLI command with one long-lived System Host per machine (user-systemd system.service, socket-activated), reached through a Unix-socket API by the CLI and by agents through an MCP adapter; independent steps run in parallel within per-Account limits.
related: [ADR-0001, ADR-0004, ADR-0005]
---

# One long-lived Host per machine

## Context

Today every `system` command boots its own DSH host on the same store. The
hosts coordinate through files: a per-Work lock, a takeover mutex, and a
write fence. In one day, five defects came from this model:

- an empty lock;
- stale-lock removal moving a live lock;
- a stale store snapshot overwriting events, because DSH `storage-domain`
  loads a table once per host;
- SQLite store-creation races;
- the profile config being rewritten under a reader.

All are fixed, with tests. But every new form of concurrency would need more
of the same: parallel steps, many Works at once, and the target of 20
Workers. Agents such as an Orchestrator also need a stable interface, not a
CLI to scrape.

## Decision

1. **One Host.** A single long-lived System process per machine owns every
   Work. Each `DSH_HOME` has one Host. It holds the Work table in memory and
   is its only writer.
2. **Service.** `system init` installs a user-systemd unit named
   **`system.service`**. The unit of System 1 that used this name was removed
   at the operator's request. The unit is **socket-activated**: systemd holds
   the socket and starts the Host on the first connection.
3. **One API, two clients.**
   - The Host serves one API on a Unix socket under `$DSH_HOME/system/`.
   - The CLI becomes a thin client of that API.
   - **`system mcp`** is a stdio MCP adapter over the same API, for agents
     such as Claude Code.
   - MCP offers every operation except `approve` and `deny` (only a human at
     a terminal), `credentials set` (only the operator) and storing a
     conversation (agents may only preview it).
   - Every call records its caller.
4. **One mode.** The one-host-per-command mode is removed, not kept beside
   the Host. Tests start a Host in-process or on a temporary socket.
5. **Parallelism.** The Host runs ready, independent steps (such as
   Brainstorm's two proposals) and separate Works concurrently. The limit on
   simultaneous attempts is **per Account**: 1 by default, configurable in
   the profile.
6. **What goes.** The cross-process per-Work locks, the takeover mutex and
   the write fence are replaced by the Host's single ownership. The
   one-Host-per-`DSH_HOME` guarantee itself still needs a lock.
7. **What stays.**
   - DSH composition, storage and plugins.
   - Event-sourced Work records and their replay.
   - Artifact IDs.
   - Verifiers and effects, with their reconciliation after a crash.
   - Human-only approval.

## Consequences

- One class of defects goes away: those that came from several processes
  owning the same Work. Crash recovery remains: the Host replays and
  reconciles on start, as `work run` does today.
- Parallel steps become possible without new coordination files.
- The CLI depends on a running Host. Socket activation starts the Host on
  demand. A Host that fails to start is reported as such, and the command
  does not quietly run on its own.
- The milestone is large and hard to reverse. It ships as its own PR after
  PR #3, with its own gate in [PLAN.md](../../PLAN.md).
- Deferred to a later milestone:
  - the Orchestrator as a scoped caller tied to a Goal (a future ADR);
  - an Orchestrator that System spawns on a schedule.

## Amendment (2026-11-06, before implementation)

A necessity review ([PROP-0004](../proposals/PROP-0004-host-design.md),
Brainstorm Work `work:5e9141d7…`) and the operator changed the following.
The rest of this decision stands.

- **Point 2:** a plain user unit `system.service` with `Restart=on-failure`
  and the PATH captured at `system init`, plus lingering so it runs after
  logout. **No socket activation.** The CLI pings the Host with a timeout and
  says whether it is not running or not answering. Trigger to revisit:
  starting the Host by hand becomes a recurring cost.
- **Point 3:** **`system mcp` moves to milestone O** (Orchestrator), its first
  real agent caller. H keeps the operation table with an `agent` flag, and a
  test that agents cannot reach approve, deny, `credentials set` or
  conversation storage. Trigger to bring it forward: an agent must drive
  System before O.
- **Point 4:** the old mode is removed in the cutover change itself, with a
  cutover and rollback checklist, instead of in a later change.
- **Point 5:** parallelism ships as a second release of H (R2), after the
  serial Host (R1) is correct.
- **Added:**
  - every mutating call carries a client `commandId`, whose receipt is stored
    in the same Work write;
  - client and Host check each other's version when they connect;
  - every call records its caller;
  - read commands also go through the Host.

