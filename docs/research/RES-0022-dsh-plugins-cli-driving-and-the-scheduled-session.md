---
id: RES-0022
type: research
status: active
summary: What System can use from the DSH bundles dsh-base and dsh-web-app, how Orca, Paradev and dsh-oh-my-claude drive Claude Code, Codex and Antigravity (also over ACP and DSH headless), what System records about tokens and Attempt logs, what resuming a Worker's session would save, and how the Scheduled session did over 11 starts; settled on 2026-11-28 as ADR-0020 and Items sch-1 to sch-7, alog-1, alog-2, sum-1, fin-1, trace-1 and cite-1.
related: [ADR-0020, ADR-0004, ADR-0012, ADR-0016, RES-0015, RES-0016, RES-0017, RES-0021]
---

# DSH plugins, how others drive the agent CLIs, and the Scheduled session

**Research as of 2026-11-28; evidence for a decision, not the decision.** Written by a caller session for the
operator's questions: can a plugin of the DSH bundles be used by System or replace part of what it does (the schedule
for the night session was the example), how do Orca and Paradev call the CLIs, and would Claude Code, Codex and
Antigravity through DSH headless give token tracking and stored sessions. What the operator settled is in
[Settled on 2026-11-28](#settled-on-2026-11-28); the rest are candidates.

## Sources

Twenty-five read-only studies by Sonnet subagents, each on one question, with file and line references; the caller
checked the deciding claims in source and re-ran the scripts behind the numbers. No citation check was run on them.

| Read | Version | Licence |
|---|---|---|
| DSH (`@deepseek-ai/dsh`, the pin of [[ADR-0004]] decision 15) | 0.2.2-rc.5 | as shipped |
| [lcestou/dsh-oh-my-claude](https://github.com/lcestou/dsh-oh-my-claude) | 1.7.1, `00cd91dc` | MIT |
| [stablyai/orca](https://github.com/stablyai/orca) | `73cec78` (2026-11-28) | MIT |
| [paradevai/paradev](https://github.com/paradevai/paradev) | `b0b0cdc` (2026-11-27) | MIT |
| `@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp` | 0.107.0, 2.1.0 | Apache-2.0 |
| `dsh-codex-subscription` (in the operator's `superman` profile) | 3.2.5, `5a64edcf` | MIT |
| Claude Code, Codex, Antigravity as installed | 2.1.325, 0.171.0, 1.5.19 | |

System was read at `dev` `7029ac57`. The numbers on Works come from the Host's records on this machine: the last 400
Works in a terminal state (admitted 2026-11-17 to 2026-11-28), 486 Attempts with their stored logs. One real call was
made: a one-turn `claude -p --json-schema` on the cheapest model, for fin-1.

## Settled on 2026-11-28

The operator's measure for a Scheduled session: every Item that was Ready when a pass started ends the pass merged,
held or failed with a recorded cause, and the operator gets a notification, also when the pass could not start.

- [[ADR-0020]]: the Scheduled session becomes a deterministic caller driven by a Schedule (sch-1 to sch-7).
- One whole Attempt log and the prompt as Artifacts (alog-1); reads bounded where they are shown (alog-2); token
  totals and the cache-read share from records (sum-1); the checked final result for Claude Code (fin-1); a trace of a
  Work (trace-1).
- `research.citation-check` refuses internal addresses and changes nothing else (cite-1).
- GLOSSARY gains **Attempt log** and **Schedule**; a Scheduled session releases only a commit the Operator approved.
- Not taken up, each with what would reopen it: [Candidates](#candidates-not-taken-up).

## DSH bundles: what System can use

`dsh-base` has 99 rows and `dsh-web-app` adds 99 and patches 24. Every row's `inject` was read from source.

- **Nothing more can be mounted in the Host.** Beyond the six packages the bundle mounts (storage, storage-sqlite,
  storage-domain, attachment-local, subprocess-local, credentials-local), every row either needs `agents`, `sessions`,
  `tools` or `systemPrompt` (the agent loop's services), or is browser UI, or is specific to the DeepSeek account. A
  page of `dsh-web-app` pulls in about 21 client packages and `dsh-base`.
- **`dsh-schedule`** (only in `dsh-web-app`) delivers a prompt into a DSH agent's Session and nothing else:
  `static inject = ['agents','sessions','storageDomain','sessionPersistence']`, no shell command, event or callback as
  a fire action, and its receipt proves the delivery, not the result. `dsh-jobs-local` is in-process and dies with the
  harness; a goal is not resumed after a restart without a person.
- **MCP.** DSH has the client half only (`dsh-mcp-client`, `dsh-mcp-manager`, `dsh-mcp-resources`; it ships
  `@modelcontextprotocol/client` and no server). System has the server half on the official SDK. A DSH profile
  becomes a System caller with one `dsh-mcp-manager` entry (`command: system`, `args: [mcp]`), no code. System should
  not write an MCP client of its own.
- **Seams usable later:** `llm` with an API-key adapter for the Classifier (it needs an exception to "no model
  adapters in the profile", and the Classifier's gate has not passed); `otel` (sends nothing by itself);
  `authorization` (fits a login that stores a token, which System's logins do not).
- **`dsh-web-fetch-http`** is not a better base for citation checks: same-origin redirects only, text only, no content
  hash, and no address check either.
- **A browser approve button is not safe:** every authenticated browser peer is the owner, and an agent in the same
  Host process or any process of the same user can do what the button does.
- **Nothing in either bundle sends a notification to a phone.**

### Sandbox (`dsh-sandbox-local`)

System's layer and DSH's bwrap profile both start from `--ro-bind / /`. The difference is that System then hides the
home and `$DSH_HOME/system` with `--tmpfs` and binds a few paths back, and DSH's `SandboxPolicy` has no word for that:
its fields are `mode`, `workspaceRoot`, `additionalWritableRoots`, `sessionId`. To carry System's layer it needs hidden
roots, read-only roots and single-file binds (git's `config` and `hooks/`). A `runnerCommand` wrapper can add them
after DSH's arguments, since the last mount wins, but then the probe is skipped and enforcement is always reported
`full`. DSH has what System lacks: a report of full or partial enforcement, and a Landlock runner where user
namespaces are off (this machine's 5.4 kernel has no Landlock; Landlock cannot hide a path).

### Plugin management

System has no second plugin manager: `system init` runs `dsh plugin --profile system install`, which is
`dsh-plugin-manager` used as a library. `profileContext` is provided by the launcher for `--profile system` too.

- `dsh-hmr` must stay out: it watches the targets of linked packages, so it would swap code under running Works when
  `system update` moves `current`, past the drain. No System plugin declares a volatile config field, so any row's
  config change remounts it.
- `dsh-config-editor` writes only the profile's `cordis.patch.yml`; the Accounts and the optional rows live in the
  `--patch` overlay `~/.system/profile.yml`, which wins. The docs name both files in different places.
- `dsh-host-plugin-inventory` reads what `doctor.ts` keeps as a hand-written list (11 rows, three missing, a check of
  the service's existence only).
- The invariant "plugin admission must respect dependency, version and security checks" has no code for a
  third-party plugin. `dsh-plugin-manager` checks `engines` and peer ranges; it has no signature and no review.

### What the workflow engine teaches

`dsh-workflow-ptc` runs a script the model writes; it has no journal, resume or replay, and stays out. Four things in
it met a real gap in System: a step's output shape is checked at the step (plan-items and brainstorm have no
verifier); a tool result is bounded and marked (alog-2); a parameter's rule sits on the parameter
(`packages/host/src/operations.ts` has 31 summaries and one `.describe(`); a Workflow says once when to use it.

### DSH headless as a fourth Runtime

`dsh --profile headless --json --permission-mode workspace-write --approval-policy never --add-dir <git dir>` runs one
task and exits; `step_end` events carry usage; nested bubblewrap worked inside System's layer on this machine. Open:
no schema flag for the final result, the model is chosen by a `--patch` overlay, no quota or cost read, and it needs a
pay-per-token key, so [[ADR-0004]] and ADR-0005 would change. Orca runs `dsh --profile headless -` the same way.

## How others drive the agent CLIs

| | Claude Code | Codex | Antigravity and others |
|---|---|---|---|
| Orca | Agent SDK `query()`, prompt on stdin; TUI in a PTY for terminals | `codex app-server`, one shared per account home | `agy acp`; 17 CLIs over ACP, about 40 TUIs |
| Paradev | Agent SDK; now `claude-agent-acp` for new chats | `codex app-server`; now `codex-acp` | ACP |
| System | `claude -p`, stream-json, one per Attempt | `codex exec --json --ephemeral --output-schema` | `agy -p --json-schema` |

- **Why they differ.** No project states a reason; the code shows it. Each vendor ships a different machine
  interface, and Antigravity serves outside clients only over ACP. A product with a person watching takes the richest
  one, for rewind, fork, steering and approvals ("ACP has no stable rewind or goal methods", Orca). ACP covers the
  rest but each agent needs a dialect file, and it has no quota read and no structured final result. Paradev moves
  Claude Code and Codex onto ACP adapters to have one chat path.
- **Where System is stricter.** Paradev's presets bypass permissions by default and Orca offers it; both write hooks
  into the user's `~/.claude` and inherit the shell's environment; neither has an OS layer locally; both read quota
  from undocumented endpoints. System has a fixed allow and deny list, a throwaway home, the layer, and reads quota
  through the CLI.
- **Neither does anything for the prompt cache**; they reuse it by keeping one process per chat.
- **Gaps in System the reading showed:** Codex has no `exclusive` per home although the docs record lost token
  refreshes (Antigravity has it since agyconc-1); no handling of `unknown option` (a CLI that drops a flag fails the
  step as the change's fault); `api_retry` frames are not read; the prompt is on argv, where all three others use
  stdin; no auto-update switch in the Attempt's environment.

### Through DSH headless, and through ACP

The operator's condition was token tracking and a stored session. It does not hold.

- **Claude Code through `dsh-oh-my-claude`:** the plugin reports the prompt and cache counters of the last API call of
  a turn, not their sum (`src/translator.ts:724-731`, on purpose, for DSH's context meter), never reads `modelUsage`,
  and its cost is not in headless output. The DSH session log keeps 600 characters of a tool result. Its default keeps
  a process alive past `dsh` and ignores SIGTERM. System's adapter already sums `modelUsage` with cost.
- **Codex and Antigravity through DSH:** every route with usage in DSH replaces the CLI by DSH's own loop on the
  subscription's backend (`dsh-llm-pi-ai` has `openai-codex`); every route that keeps the binary is a subagent
  provider, whose result has no usage and which needs a parent model. Antigravity has no route.
- **All three over ACP:** the schema has `usage` with cached read and write tokens. `codex-acp` fills it from
  `tokenUsage.last`, the last call (`dist/index.js:30952`); `claude-agent-acp` leaves subagents out of the typed field;
  one trivial fixture exists for `agy acp`. Both adapters are Zed's, not the vendors', and add a process per Attempt.
  Codex loses `--output-schema` and `agy acp` has no `--json-schema`.

## What System records

| Runtime | Attempts | Input tokens | Cache-read share | Log cut |
|---|---|---|---|---|
| Claude Code | 369 | 299.5 M | 94.8% | 104 (28%) |
| Antigravity | 60 | 80.1 M | 91.0% | 1 or 2 |
| Codex | 38 | 16.0 M | 87.1% | 19 (50%) |

- Usage with the cache split is in every observed event; only Claude Code reports cost ($125.72 over the 369). For
  Claude Code 0.2% of input was uncached, and every cache write was in the one-hour tier.
- No command gives the cache-read share or totals by day, Account or Runtime; a night's totals were summed by the
  model that wrote the report.
- The stored log keeps 64 KiB of head and the tail within 256 KiB. Whole logs are small: median 130 KB, 99th
  percentile 0.9 MB, largest 1.5 MB, 94 MB for 484 Attempts. The prompt is not stored.
- Codex and Antigravity end with a checked `{status, reason}`; Claude Code does not, though `--json-schema` exists and
  puts the object in `structured_output` of the `result` event.
- A failing check is not in the Worker's log. It is in the verdict and check-run Artifacts that the `reopened` event
  names. Thinking blocks in Claude Code's stream are empty, so the log shows what was done, not why.

## What resuming a Worker's session would save

A reopened step does not start over: its working directory starts from the earlier change, and it gets the failing
verdict and a file for each failing check. What it lacks is the earlier Worker's reading.

- Of 110 reopenings, 76 followed a failing verdict, 26 a refused publish and 8 a retryable failure; 2 Attempts were
  lost, both verifier Attempts. No Claude Code Attempt in 486 timed out, hit a quota or crashed.
- A repair after a failing verdict takes 99 seconds (median) and spends 14.5 of them before its first edit; about a
  fifth of its cost repeats what the Attempt before it did. The wait between the two is the checks, 8 minutes.
- With a warm cache and all of that reading skipped, a resumed repair costs 74% of a fresh one, about 1.5% of all
  Claude Code spend, and processes 40% more tokens. With half skipped it costs 108%; with a cold prefix, 2 to 3 times.
- Of 109 repairs, 79 went to the same Account (67% of those Works succeeded), 14 to another Account of the Runtime
  (50%) and 16 to another Runtime (75%).
- Each CLI has a resume flag. A resumed Claude Code session carries the deleted Attempt directory's absolute paths;
  `codex exec resume` takes no `-C` or `-s`; a raw session file bypasses the log's redaction.

## The Scheduled session, 2026-11-18 to 2026-11-28

| Outcome | Starts | Which |
|---|---|---|
| Did the planned work | 2 | 11-21 (2 Items merged), 11-27 (22 Items: 21 merged, 1 held) |
| No Ready Item | 8 | nothing was planned the day before |
| Lost | 1 | 11-28: the layer hid Node 24, `system mcp` exited; the unit ended `Succeeded` |

- On 11-27 the 01:00 start failed on "the Host does not answer" and a start at 01:05 ran the night; what started it is
  not known.
- No notifier was configured, so no start ever notified. The unit runs the checkout's script, not the install's. Its
  limit is 6 hours and the 11-27 night took 5 h 57 min. Works ran one at a time with 8 Accounts registered.
- The caller's own usage is recorded nowhere; from Claude Code's transcripts, 11-27 took 328 turns and 41.5 M cached
  tokens, about 235 of the turns being 90-second waits.

## Candidates not taken up

| Candidate | What would reopen it |
|---|---|
| DSH headless with a DeepSeek model as a Runtime | a night with every subscription Account out of quota, or the operator wanting a pay-per-token fallback |
| ACP as a transport | a fourth Runtime that speaks ACP itself (gemini, opencode, copilot); never the adapters for Claude Code and Codex |
| Resume of a Worker's session | an Attempt that dies after many minutes of work and loses its partial change |
| `dsh-sandbox-local` in place of the layer | DSH's policy gaining hidden and read-only roots; meanwhile ask for them in a DSH Discussion |
| `dsh-host-plugin-inventory` in `doctor` | a Host start where a row failed and `doctor` said nothing |
| `dsh-config-editor` behind a `system` command | the operator's configuration moving out of the `--patch` overlay |
| `dsh-plugin-manager` mounted | the first third-party plugin; admission needs a pinned version and a recorded review first |
| Codex `exclusive` per home; `unknown option` and `api_retry` handling; prompt on stdin; no auto-update in an Attempt | the first Work that fails for it |
| A step's output shape checked by a verifier; parameter rules on parameters; `description` in a Workflow | plan-items writing a bad Item; a measured first-turn token cost |
| A read-only page in the operator's DSH web profile; a `@system/mcp-bundle` | the operator reading status from a browser; a second profile that must be a caller |

## Not verified

- Nothing of DSH, Orca or Paradev was run; `dsh-oh-my-claude` and the ACP adapters were read, not executed.
- `dsh-codex-subscription` is a 690 KB bundle that was searched and sampled, not read whole.
- What `agy acp` puts in `usage` on a real turn; whether the DSH rows named as seams load in the `system` profile.
- Whether the operator's `superman` profile and System's Codex Account are one ChatGPT account. That profile's Host
  runs DSH 0.2.0-rc.2, not the pin, and shares `DSH_HOME` (and `.credentials.yaml`) with System's Host.
- Whether a response fetched by `research.citation-check` can reach the Worker that named the URL.
