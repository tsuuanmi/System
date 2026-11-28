---
type: operations
status: active
reviewed: 2026-11-26
related: [operations/install-and-update, operations/releases, operations/accounts-and-workers, operations/scheduled-session, operations/using-system, operations/recovery]
---

# Runbook

How to run the Host of the default home (`~/.dsh`) as a user service, and
what to do when it does not. The design is in [Host](../architecture/host.md#running-it).

The Host runs as a process and the CLI is its thin client: every command but
`init`, `update`, `host` and `doctor` talks to the Host on
`$DSH_HOME/system/host.sock` (the commands of the Operator's Authority, such as `approve`, on
`$DSH_HOME/system/operator/host.sock`; [ADR-0016](../decisions/ADR-0016-the-gate-is-enforced-by-reachability.md)),
so a Host must run for them.

## Index

- [Install and update](install-and-update.md)
  — Installing System on a new machine and running its Host as a user service.
- [Releases](releases.md)
  — Updating the installed release, rolling it back, and the dev branch.
- [Accounts and Workers](accounts-and-workers.md)
  — The profile config, Accounts and their slots, and the Antigravity and web Workers.
- [The scheduled session](scheduled-session.md)
  — The deterministic caller, Schedules, the check before a pass and the notifier.
- [Using System](using-system.md)
  — Following a Work, the STATUS.md of a project, and using System from an agent.
- [Recovery](recovery.md)
  — Backing up, reading logs, and what to do when the Host or a check fails.
