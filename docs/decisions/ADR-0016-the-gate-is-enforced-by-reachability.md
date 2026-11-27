---
id: ADR-0016
type: decision
status: accepted
date: 2026-11-27
summary: A CLI Worker and the Scheduled session run inside one bubblewrap layer as the same OS user, and the operations of the Operator's Authority are served on their own socket that no sandbox binds; this replaces ADR-0011's advisory boundary for unattended work and the Claude Code-only sandbox option.
related: [ADR-0011, ADR-0004, ADR-0007, ADR-0008]
---

# The gate is enforced by reachability

Accepted 2026-11-27 by the operator (Intent
`sha256:21e4cf418770515cce1a4e980346d48cb5d7b56febc278e497dd64d632947632`).
Its Items are iso-1, iso-2 and iso-3 in [STATUS.md](../../STATUS.md); until
they are released, [ADR-0011](ADR-0011-human-caller-needs-a-terminal.md)
decision 1 describes what runs.

## Context

- A caller is a human when the CLI client says so: `process.stdin.isTTY`.
  Every operation is served on one socket, and a Worker runs as the
  Operator's OS user with the Host's `state.sqlite`, that socket and `~/.ssh`
  in reach. An agent that allocates a pseudo-terminal, or writes the store,
  passes.
- Since 2026-11-26 the Scheduled session takes every Ready Item with no cap,
  with no operator present.
- Measured on the operator's machine on 2026-11-27: bubblewrap 0.4.0 runs
  unprivileged and nested; inside it the home is hidden while `git commit`
  and the network work.

## Decision

1. **Two guarantees are enforced** for a CLI Worker and for the Scheduled
   session: it cannot call an operation of the Operator's Authority, and it
   cannot write to `dev` or `main`. Reading the Account's own model
   credential and reaching the network stay possible (ADR-0004 decision 14
   stands for those).
2. **One layer for every CLI Runtime:** bubblewrap around the Runtime's
   process, the same OS user. Hidden: the passwd home, `~/.ssh`, the Host's
   state under `$DSH_HOME/system`. Bound: the attempt's own directories, the
   repository's git data so that the attempt can commit but cannot write the
   main repository's `config` or `hooks/`, and the toolchain read-only. The
   network is kept.
3. **It fails closed:** when the layer cannot start, the attempt fails as an
   Outside failure and never runs unwrapped.
4. **Authority by reachability:** the operations whose Authority is the
   Operator's are served only on a second socket, in a directory no sandbox
   binds. The caller socket refuses them whatever the client says about
   itself.
5. **The Scheduled session** runs inside the same layer with only the caller
   socket. An interactive caller session, with the Operator present, is not
   wrapped: ADR-0011 stays the rule there.
6. **Configuration:** the Account option `sandbox` now means this layer. The
   Claude Code settings of sb-1 are deleted. Default on for every CLI Runtime
   is the Operator's decision after one Account has run one night with it.

## Alternatives not taken

- **Workers as another OS user** (ADR-0011's stated path): stronger, but the
  shared server gives no root, and worktree ownership would change.
- **Claude Code's own sandbox** (sb-1): it covers only what Claude Code's
  Bash starts, not Codex or Antigravity, it closes the network, and its test
  needs the Operator's token, so nobody had run it.
- **A secret the Operator types:** worthless while the Worker can write the
  store the Host reads.

## Consequences

- The layer's tests use a fake agent, so a Worker runs them in the checks;
  nested bubblewrap must keep working.
- A machine without unprivileged user namespaces cannot run CLI Workers with
  the option on.
- `dev` stays unprotected on GitHub (the Host and a Worker would use the same
  identity there); what keeps a Worker out of it is that the layer hides
  every credential that can push.
