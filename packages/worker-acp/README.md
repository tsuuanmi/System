# @system/worker-acp — optional Cordis Worker plugin

**ACP Worker is a plugin, not another Work Controller.** The independently
toggleable Cordis plugin registers System-owned WorkerPort instances, uses the
[official ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
**v1.4.0** for ACP v1, and uses DSH's existing subprocess service for agent
process lifetime and credentials scrubbing. No Rust binary, custom ACP wire
parser, agent loop or additional process supervisor is required.

The [DSH ACP reuse assessment](../../docs/research/RES-0010-dsh-acp-reuse-and-worker-plugin.md)
explains why `dsh-acp` (an ACP **server**) is not the client System needs,
and why the public `dsh-subagent-acp` provider requires a parent DSH Agent.
The ACP client is built using the same **official SDK version DSH pins**,
not by importing private DSH implementation files or forking DSH.

## Enable / disable

The `worker-acp` bundle row is installed but **disabled: true**. To opt in,
install an ACP-compatible agent binary and add this local profile patch:

```yaml
- id: worker-acp
  disabled: false
  config:
    accounts:
      - ref: acp/research
        capabilities: [research]
        agentCommand: /absolute/path/to/codex-acp
        agentArgs: []
        # codexHome: codex/default
        # OR tokenRef: CLAUDE_CODE_OAUTH_TOKEN
```

Restart the System Host. `system workers` reports registered WorkerRefs and
unavailable reasons. A missing ACP agent executable or auth is **not silently
replaced** with a vendor CLI. An obsolete `command` (Rust bridge) setting is
explicitly rejected.

An empty `accounts` list leaves ACP enabled as a plugin but registers no
Workers and starts no processes. Disabling removes plugin registrations; the
default headless Claude/Codex and Website Workers stay independent. For
in-flight work use a controlled drain/restart — hot-disable is not certified
to safely reclaim every active process.

The [canonical provider-neutral Worker contract](../../docs/architecture/control-plane.md#provider-neutral-worker-boundary)
belongs to System, not this plugin. The same Work Controller admits a
capable headless, ACP or Website Worker through `WorkerPort`; this plugin
only translates ACP sessions into System Attempt results and exact
Artifact IDs. Provider names, permissions and session details do not
enter Controller branching. Report unsupported capabilities as unavailable;
do not promise model-level equivalence across providers.

## Provider-neutral credentials

The ACP plugin does not assume an agent is Claude or Codex. For a new ACP
provider, map each **explicit** environment variable to a System credential
reference. Secrets are checked during account registration and resolved only
when an Attempt starts; no ambient host credentials are forwarded.

```yaml
- id: worker-acp
  disabled: false
  config:
    accounts:
      - ref: acp/external
        agentCommand: /absolute/path/to/acp-agent
        agentArgs: []
        capabilities: [research]
        envRefs:
          GEMINI_API_KEY: GEMINI_API_KEY  # variable name -> System credential ref
```

Configure the credential separately through `system credentials`. The
variable name must match the safe uppercase environment-variable format.
Names that control process execution or the DSH/System runtime (for example,
`PATH`, `HOME`, `NODE_OPTIONS`, `LD_PRELOAD`, `DSH_*`) are rejected.
The existing `tokenRef` and `codexHome` remain supported for compatibility;
neither is required for another ACP provider.

**Antigravity note:** `agy acp` can use its own signed-in credentials, a
Gemini API key, or other agent-specific authentication. Its Gemini-key flow
also requires `modelProvider: gemini` in an Antigravity settings file;
**setting `GEMINI_API_KEY` alone is insufficient**. System currently
creates a fresh per-Attempt `HOME`, so cached local login/configuration is
not automatically available. Prepare and verify an isolated agent profile
before treating Antigravity as a supported live Worker; no permission or
credential sharing is implicit.
See [Antigravity ACP documentation](https://antigravity.google/docs/ide/extensions/acp/)
and [authentication requirements](https://antigravity.google/docs/install).

## Execution contract

- One fresh ACP v1 session/process per System Attempt: initialize, new session,
  prompt and streamed updates through the **official SDK**, not custom JSON-RPC.
- DSH owns subprocess ranges, explicit environment forwarding, cancellation,
  EOF/termination escalation and observed exit. Workspace and exact Artifact
  capture live in the shared `@system/worker-execution` library.
- ACP permission prompts are **rejected**. No implicit agent tool approval,
  no System publish/merge privilege and no claim that a subprocess is sandboxed.
- Agent stop reason `end_turn` is not accepted Work by itself: exact requested
  output files/Git-tree must be captured, then System verification/approval
  gates apply. Abnormal stop/cancel/unknown process exit fails closed.
- Token usage is **unknown**, not zero. Model tiers, token-budget enforcement,
  ACP v2, persistent ACP sessions and interactive permission brokerage are
  unsupported and must not be silently emulated.

## Tests

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
python3 tools/docs.py check
python3 tools/docs.py sync --check
```

Offline tests cover SDK handshake, per-agent permission refusal, cancellation,
WorkerPort Artifact capture and default-disabled composition. A smoke test
with a real authenticated Claude/Codex ACP agent, descendant-process crash
recovery and in-flight plugin hot-disable are **separate release gates**. Keep
PR #73 in Draft until validated.
