# PLAN.md — System next implementation: dogfood

> **Status:** execution handoff, updated 2026-11-08. The next milestone is
> **DF, dogfood** (below). The checklists and evidence of the finished
> milestones are in [PLAN.md at `aaa38f6`](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md); this file keeps one line
> each. This checklist is not an ADR or an alternate source of product
> requirements.

## 0. Read and align

- [Product Charter](docs/requirements/purpose.md), [accepted ADRs](docs/decisions/README.md)
  and [MVP scope](docs/requirements/mvp.md) define product/architecture truth.
  The terms are in [GLOSSARY.md](GLOSSARY.md).
- Recheck the actual current state before changing code; do not repeat
  finished work.
- **Deferred MVP-1 items** (operator, 2026-11-08): sandbox, egress denial,
  and a plugin unload with Work in flight (MVP failure tests 3 and 4) wait for
  a Worker that runs untrusted code or content.

## 1. Finished milestones

| Milestone | What it gave | Where |
|---|---|---|
| MVP-0 | Work and Artifact IDs that survive restart, Worker takeover, effects with intent and outcome, two YAML Workflows on one controller | PR #2 (`8b6a4c8`), [MVP-0 plan](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/PLAN.md) |
| B0–B4 Brainstorm | Three Worker attempts (Claude, Codex, synthesis) from one brief; evaluation in [RES-0008](docs/research/RES-0008-brainstorm-evaluation.md); the concurrency fixes | PR #2, [section 2 and 5](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md#2-execution-checklist-and-gates) |
| P | Stance per proposal by default, System publishes its own PRs and merges into `dev` ([ADR-0008](docs/decisions/ADR-0008-dev-integration-branch.md)) | PRs #5–#7 |
| H (releases R1, R2) | One long-lived Host ([ADR-0007](docs/decisions/ADR-0007-one-long-lived-host.md)), parallel steps per Account | PRs #8–#28, [H](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md#h--one-long-lived-host-adr-0007-as-amended-prop-0004-accepted) |
| O | Goals, `system mcp`, the Orchestrator, completion notices ([ADR-0009](docs/decisions/ADR-0009-goals-and-orchestrators.md)) | [O](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md#o--orchestrator-and-goal-adr-0009) |
| A (with the speed pass F), D, L1 | Faster checks (2 min 28 s), the Host restarts itself on new code, the remote sign-in races | PRs #31–#33 |
| OC | A replaceable Orchestrator: decisions, the brief, live progress, stalls, Sub-workflows ([PROP-0006](docs/proposals/PROP-0006-replaceable-orchestrator-and-code-checks.md)) | PR #39, [OC](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md#oc--a-replaceable-orchestrator-and-the-checks-as-a-sub-workflow-prop-0006) |
| CQ | Worker policy, `paths` checks, the merge queue by leased push ([PROP-0007](docs/proposals/PROP-0007-worker-policy-checks-and-merge-queue.md)) | PR #42, [CQ](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md#cq--worker-policy-faster-and-clearer-checks-and-a-merge-queue-prop-0007) |
| After CQ | Profile patches merge by `ref`, fflate 0.8.3, the Host-exit backstop, reads while the Host waits to upgrade | PRs #45, #46, #59, #62 |
| WW | Website Workers: Runtime `web`, generic Procedures on a UI map, Power by tier, the canary, `citations-v2`, `research-fanout`; built by System Works on branch `web-workers` | [WW](#ww--website-workers-that-work-built-with-website-workers-branch-web-workers) |

Who built them: PRs #5–#36 were System Works, apart from #34 and #35 (the
operator's sessions); OC, CQ and the PRs after CQ were built by the
operator's sessions directly. DF turns that back.

## 2. Growth and feedback budgets (Charter 11 and 12)

Record the measures at the end of every milestone. Growth above budget is
justified in the milestone's row or paid for by removal. The core budget is
+10% per milestone from 3,403 lines
([ADR-0010](docs/decisions/ADR-0010-core-budget-rebaselined.md)); the older
columns are history, and the reasoning behind each is in [PLAN.md at
`aaa38f6`](https://github.com/tsuuanmi/System/blob/aaa38f616c53b31003629fdb67a53bec1a06d80f/PLAN.md#growth-and-feedback-budgets-charter-11-and-12).

| Measure | Baseline (PR #3, 2026-11-06) | Budget per milestone | R1 (end of H4, 2026-11-07) | H, before the pass | H, after the pass | O, before → after the pass | F, speed pass (2026-11-07) |
|---|---|---|---|---|---|---|---|
| Active core: `packages/work/src` + `packages/artifacts/src`, lines | 2,317 | +20% | 2,564 (+10.7%) | 2,913 (+25.7%) | 2,953 (+27.4%) | 3,006 (+29.7%) → 3,008 (+29.8%) | not measured |
| All package source, lines (`.ts` and `.mjs` under `packages/*/src`) | 4,081 | recorded | 5,299 (+29.8%) | 6,349 (+55.6%) | 6,374 (+56.2%) | 6,722 (+64.7%) → 6,735 (+65.0%) | not measured |
| Tests: `packages/*/tests`, `tests` and `test-support`, lines | not recorded | recorded | not recorded | 6,906 | 6,832 | 7,364 → 7,351 | not measured |
| Docs under `docs/`: lines (files) | 3,571 (37) | +20%, and no fact stated twice | 4,284 (43) (+20.0%) | 4,557 (44) (+27.6%) | 4,557 (44) (+27.6%) | 4,648 (44) (+30.2%) → 4,283 (44) (+19.9%) | not measured |
| Unit check, clean worktree | ~1 min | under 2 min | 39 s (install, build, typecheck, test) | not measured | not measured | not measured → 1 min 14 s (install 7 s, build and typecheck 29 s, test 37 s) | 1 min 14 s → 1 min 14 s, now four checks (install 9 s, build 23 s, typecheck 6 s, unit 38 s); install and build run once for all checks |
| All required checks (`.system/checks.yaml`) | ~7 min | under 10 min | about 5 min (docs 2 s, unit 39 s, smoke 4 min 14 s) | not measured | not measured | not measured → about 7 min 20 s (docs 2 s, unit 1 min 14 s, smoke 6 min 9 s, run beside another job) | 7 min 20 s → 2 min 28 s (docs 0.4 s, install 9 s, build 23 s, typecheck 6 s, unit 38 s, smoke 1 min 12 s); goals met: all checks under 3 min, smoke under 2 min. Measured with `env -i PATH LANG HOME=<fresh> CI=1 sh -c`, one shared HOME, from a clean copy. Smoke 5 runs in a row: 70/70 each, 73 to 76 s, no leftover processes |
| Flaky tests known | 0 | 0: a flaky test is fixed before features | 0 | 0 | 0 | 0 → 0 | not measured |
| Host `recordBytes` | n/a | recorded | 11,308 for three Works (Software Engineering, Research and a direct Task, fake Workers) | not measured | not measured | not measured | not measured |
| Tokens per Work | n/a | Fresh input, cache read, cache write, output, recorded per milestone; usage includes every turn of an attempt and, for Claude Code, subagents (`modelUsage`) and the CLI's own `costUsd`; USD figures are API-equivalent estimates, not what the subscription is billed | | not measured | not measured | not measured | not measured |

| Measure | OC, after the pass (`a4862d7`) | CQ (`6d92315`) |
|---|---|---|
| Active core, lines | 3,403 | 3,420 |
| All package source, lines | 11,062 | 11,366 |
| Tests, lines | 9,540 | 9,712 |
| Docs under `docs/`, lines (files) | 4,821 (46) | 4,985 (48): over the 4,285 limit by the WW programme's documents |
| Required checks | 5 min 44 s at a load of about 270 | 4 min 45 s at a load of about 210; 4 min 20 s on a quiet machine, about 2 min 20 s without WW's three headed-browser test files |

Every milestone ends with a **simplification pass**. A System Work (Sonnet)
proposes deletions and simplifications: dead code, unused abstractions,
duplicated tests, docs that restate others. The operator reviews it like any
PR. After each milestone, the Sonnet code review's Standards axis also checks
the code against Charter items 8, 11 and 12.

## 3. DF — Dogfood (decided 2026-11-08)

**Aim:** System develops System. No new feature in this milestone; unneeded
logic may be removed. The core-debt cuts of
[ADR-0010](docs/decisions/ADR-0010-core-budget-rebaselined.md) are its first
Works, so trimming the core and proving the dogfood are one job.

**Sessions** are replaceable ([AGENTS.md](AGENTS.md#sessions)).

- [x] DF0. Release: `dev` merged into `main` (PR #71); PR #3 closed, PR #4
  was already merged; the release report deleted (PR #70).
- [ ] DF0b. An install apart from the development checkouts (operator,
  2026-11-08). Today the live Host runs from the development checkout with
  its config in a session's `/tmp` scratchpad, against the Sessions rule.
  Done by the Development session as a blocker fix ("fixed outside System"):
  - `~/.system/releases/<commit>/`, one install per commit of `main`, never
    edited by hand; `~/.system/current` points to the one the Host runs;
    `~/.local/bin/system` links to `~/.system/current/bin/system`;
  - `~/.system/profile.yml` holds the Accounts and Effects (replacing the
    `/tmp` patch); the store and secrets stay in `~/.dsh/system` (DSH's);
  - the Host runs as the `system.service` user unit, from `current`;
  - `system update`: fetch `main`, install and build it into a new release,
    run that commit's own `.system/checks.yaml` there, and only when they
    pass switch `current`, so the Host restarts on it (D); if the new Host
    does not come up, switch back. Code that has not passed its checks on
    this machine never runs live. A script outside the core;
  - System 1 is only a reference now: its launcher and its install
    (`system-live`) go; the source `~/workspaces/system` stays;
  - last, `system mcp` without `--goal` registered at user scope, so a
    session in any repository has System's agent tools (no approval: that
    stays human, at a terminal). A Goal-scoped Orchestrator stays a folder
    of its own (`~/workspaces/system-orchestrator`).
- [ ] DF1. One Goal, "a smaller core, the same behaviour", with an attempt and
  token budget. The Orchestrator is a **new** Claude Code session connected
  only to `system mcp --goal`, with no shell, edit or push. It runs Works up
  to their approval; the operator approves and merges. Claude Code's `/goal`
  keeps the session going, with a stop condition read from System (every
  scope item has a Work at approval, or the budget is spent); System's Goal
  holds the budget, the authority and the state any session takes over from.
- [ ] DF2. Core debt, each cut one Work and one pull request, with tests
  showing the rest behaves the same, and the core's line count recorded
  after each:
  - without dropping a feature (about 35 lines, about 75 with header comments
    that restate ADRs): `Host.interrupted`, used only by tests; the `Host`
    pass-throughs to the controller; the `executor` and `usage` shapes written
    twice;
  - drop the conversation intake (`system conversation add`, about 43 core
    lines); the `conversation@1` kind stays, the ChatGPT Worker stores one per
    exchange;
  - keep Goals, decisions and the Orchestrator caller, live progress and
    stalls, and Sub-workflows: DF uses them. At the end of DF, a feature that
    no Work used is proposed for removal.
- [ ] DF2b. One automatic fresh attempt per Work after a conclusive failure
  (operator, 2026-11-08; decided on `web-workers`, PLAN "Decisions of
  2026-11-08, second round"), a System Work of this Goal after DF0b. Allowed
  after a failure before the send, a site error, or a complete but malformed
  answer; never after an unknown send, a challenge, a sign-in wall or
  `invalid_state`. The Worker says whether a failure may be tried afresh,
  through the port and in generic terms; the counter is durable across
  restarts and Accounts; the fresh attempt starts clean (a new chat), and its
  evidence and event say it was automatic. Basis: 1 of 20 canary runs failed
  on a missing output block; one fresh attempt would bring acceptance to about
  95%. Until it ships, `work retry` by hand.
- [ ] DF3. Replace the Orchestrator mid-milestone: stop its session in the
  middle of a Work, start a new session with only `system goal brief`, and it
  carries on without reading PLAN, an old chat or a memory. Whatever it has to
  ask or guess is a defect: a record System is missing.
- [ ] DF4. Check time measured again once WW is on `dev`; over 3 minutes is a
  defect.

**Done =** at least five consecutive changes into `dev` made by System Works,
each recording the operator's touches, time, usage and failed attempts; DF3
passed; the attempt budget, live progress and an Orchestrator over
`system mcp` exercised for real.

**Defects found by DF** are fixed before features. A defect that blocks DF
may be fixed directly by the Development session, marked "fixed outside
System" and not counted among the five. The Host hang behind PR #59 gets no
separate investigation: if it recurs, its log names the cause and it becomes
such a defect. Outside those fixes, the Development session only reviews
System's pull requests when the operator asks, and writes docs pull requests.


### W — ChatGPT Website Worker (PROP-0005, after H release R1)

- [ ] Design: [PROP-0005](docs/proposals/PROP-0005-chatgpt-website-worker.md)
  (accepted 2026-11-07). The operator accepted the Terms-of-Use risk for their own account
  (2026-11-06).
- [x] Re-run the three research Works (tokens, existing drivers, risks) after
  the verifier fix V1. *(2026-11-07, verifier v2, ratio 0.5: tokens `851ec77c`
  5/8 quotes confirmed, drivers `12143a0f` 5/7, risks `8aaea4d6` 8/9 (one
  page 403); all accepted, the unconfirmed listed in each verdict; 82-108 s
  and about $0.22-0.29 (estimate) each.)*
- [x] Build after R1: the `chatgpt-web` Runtime on Playwright, a dedicated
  signed-in profile, one prompt per attempt, completion detection, answer
  and cited links as outputs, each exchange recorded as a `conversation@1`,
  and deterministic tests on a local fake page. *(2026-11-07, W1: PROP-0005
  accepted; `system workers login`, cookie import; not enabled in the bundle;
  the real-site run, `SYSTEM_REAL_WEB=1`, is still to do.)*

- [x] W2. Remote sign-in over SSH, as System 1 does (operator, 2026-11-07).
  *(2026-11-07: pure Node, no VNC and no new package.)*
  - `system workers login <ref> --remote` opens the account's profile headed
    on its own Xvfb and serves a viewer on 127.0.0.1 behind a random 32-byte
    token: a CDP screencast over Server-Sent Events, input sent back by POST,
    **Save** and **Cancel**, a 15-minute TTL. The CLI prints the
    `ssh -L <port>:127.0.0.1:<port> <user>@<host>` line and the URL.
  - No CDP port is exposed (Playwright's pipe). A human clears a challenge in
    the viewer; System never does.
  - **System never runs the browser headless** (operator, 2026-11-07): attempts
    and login use a real headed Chrome on the operator's `DISPLAY` or a private
    Xvfb it stops with the attempt; the `headless` option is gone; without
    Xvfb the account is `unavailable`.
  - Reference: System 1, `docs/design/browser-runtime.md` ("remote" flow).
  - Cookie import (`--cookies`) stays as the quick path.
  - Verified here by the unit and Host tests; the browser tests are skipped
    where a headed Chrome does not start on an Xvfb (the Chrome 95 on this
    machine crashes on start when headed), so a headed run is still to do on a
    machine where it starts.
  - Parallel-merge interaction fixed (L1) *(2026-11-07)*. W2, A (faster
    checks, tests in parallel) and D each passed alone; their merge turned
    `dev` red. Cause, two races in W2's code, both made likely by the parallel
    runs: (1) `agentWorker` closed the browser from the abort and again at the
    end, and the second `close()` returned before Chrome had exited, so the
    attempt ended with Chrome and its profile still in use (the test then read
    a dead or half-gone process, and the file's cleanup hit a profile still
    being written); (2) `startXvfb` took the first X socket it saw, which
    could be another Xvfb's when two started from the same display number, so
    two attempts shared a display and one Xvfb exited under its browser.
    Fixed in the code (`chatgpt.ts` shares one close; `display.ts` takes a
    display only when its lock names its own Xvfb); a test starts four Xvfbs
    from the same number. Not the tests' fault, and not Chrome's zygote.
- [x] W5. Port System 1's browser runtime and make `dev` green again
  (operator, 2026-11-07). *(Real-site result pending: the operator runs it.)*
  - Evidence from the real site: a signed-in account reported as challenged (a
    false positive), and Turnstile looping on a second account. Cause by
    comparison: Playwright's default launch advertised automation and used
    `--no-sandbox`, `--password-store=basic`, `--use-mock-keychain` on
    Chromium 136. System 1 launches a genuine Chrome and works.
  - `playwright-core` is replaced by `patchright-core` 1.63.0 (System 1's pin),
    launched with System 1's `CHROME_ARGS` and `ignoreDefaultArgs`; Chrome is
    chosen as System 1 does (`chrome.ts`, `chrome.lock.json`: configured path,
    `CHROME_PATH`, a recent system Chrome, else Chrome for Testing 155.0.8059.39,
    installed on first use; it runs on this Ubuntu 20.04, glibc 2.31). Page
    state, Chat mode and the Work refusal are System 1's logic in a selector
    table and scripts, `SELECTORS.version` 2. PROP-0005 records that System 1
    used VNC (real X input) and that CDP-dispatched input is the difference
    left if a challenge still loops.
  - `dev` was red: Chrome aborts with `Socket path too long` when `TMPDIR` is
    deeper than about 55 bytes, and the verifier's throwaway HOME is. The
    headed tests were **skipped** there (the probe saw Chrome die), so the
    required checks passed on L1 without running them: a coverage gap. Fixed
    in the code (Chrome gets a short `TMPDIR`) and in the checks: a headed
    Chrome that cannot start now fails these tests (`SYSTEM_SKIP_HEADED=1`
    opts out); the tests use the Chrome the Runtime chooses, installed once
    into a cache shared by the test processes.
  - `bin/system` supervised only when `host` was `args[0]`; it now finds `host`
    after DSH's options (`--patch X host --supervise`).
  - The one change to `pnpm-lock.yaml` is the dependency swap itself
    (`playwright-core` out; `patchright-core` and `@puppeteer/browsers` in),
    which `--frozen-lockfile` needs.
- [x] W7. Port System 1's ChatGPT web driver, its UI map and its UI engine
  (operator, 2026-11-07, said twice). *(Real-site result pending: the
  operator's agent runs `SYSTEM_REAL_WEB=1 node --test tests/real-web.test.ts`
  after the merge.)*
  - Why: W5 and W6 re-implemented parts of System 1's driver as a small
    selector table and met problems System 1 had already fixed (a stale send
    selector, `?temporary-chat=true` navigation aborted, a false challenge).
    System 1 works against chatgpt.com, so its logic is copied, with its
    comments, and not written again.
  - New package `packages/web-driver` ([README](packages/web-driver/README.md)):
    System 1's `ui-ops` (engine, map, locate, outline, network, answers, site,
    heal), its `provider-chatgpt-web` driver, UI map and fake site, and only the
    parts of `provider-core` and `libs` they import. Each file names its source
    path and System 1's commit (`f199a277`); the README lists every difference
    and why (no Cordis glue; reports go to the attempt's log, heal off; the
    map schema is checked with `ajv` without format checks; parameter
    properties as fields; a fixture without `otpauth`). Dependencies: `yaml`
    2.9.1 (System 1's pin) and `ajv` 8.20.0 (already in the lockfile through DSH).
  - `packages/agents/src/chatgpt.ts` uses the driver: `ask` opens a temporary
    chat in Chat mode (the operator's default), checks the sign-in, sends and
    waits; the answer's Markdown comes from the page's Copy. Deleted: the
    `SELECTORS` table, the page-state and send/wait scripts, `classify`,
    `settle` and `pageState`, the stage `send` and its timeout, and the tests
    the ported ones cover. Kept: never headless, the private Xvfb, the
    persistent session-bound profile, the `conversation@1` record, the output
    blocks, cancel and the attempt time limit. The remote login's Save check is
    the driver's `checkAuth`.
  - Test evidence here: the ported engine tests (9), the driver tests against
    the ported fake site (3), the Runtime's attempt tests against it (24), the
    remote-login tests (11) and the booted `chatgpt-web` smoke test (4) pass on
    a headed Chrome on Xvfb.
  - **Growth recorded** (lines of `.ts` and `.mjs`; the baseline is `dev` at
    `a63457f`): the active core (`packages/work/src` + `packages/artifacts/src`)
    is 3,076 before and after, **unchanged**; all package source 7,705 → 10,469
    (+2,764: `packages/web-driver/src` 3,006, `packages/agents/src` 1,935 →
    1,693); tests (`packages/*/tests`, `tests`, `test-support`) 8,603 → 9,421
    (+818: System 1's fake site is 672 of them). The growth is the ported
    code, which is the decision; it is outside the core's budget, and the
    next milestone should check that none of System 1's unused procedures
    (Deep research, deletion, credential sign-in, heal) is kept without a use.
  - `pnpm-lock.yaml` is not part of this change (instructions): the new
    workspace package needs its importer entry (`yaml`, `ajv`, `patchright-core`
    under `packages/web-driver`, `@system/web-driver` under `packages/agents`),
    which `--frozen-lockfile` wants; regenerate it with
    `corepack pnpm install --no-frozen-lockfile` when merging.
- [x] W8. Read a ChatGPT answer's output blocks with their fences (follow-up
  to W7; operator's real-site run, 2026-11-07).
  - Evidence: the whole turn worked through `packages/web-driver`, and ChatGPT
    wrote a `report` and a `sources` block, but the attempt failed with "wrote
    no output block": the answer recorded was the rendered text (header and
    content, no fences). No "copy refused" note was logged because System 1's
    `markdownOf` returns the rendered text silently when Copy's code blocks do
    not pair with the page's `pre code`.
  - Fix, from System 1's own `answer.code` map entry: when the answer text has
    no fence, `withFencedBlocks` fences each `pre code` block again with its
    header as the info string (README, "Fences without Copy").
  - Red test first: driver tests where the fake page's Copy gives text without
    fences, and where it gives nothing, must still fill `report` and `sources`.
- [ ] W3. Two ChatGPT accounts for Brainstorm (operator, 2026-11-07). With
  temporary chats, two signed-in accounts (`chatgpt-web/default`,
  `chatgpt-web/second`) can each give an independent proposal. A Brainstorm
  variant in `workflows/experiments/` routes `idea-a` and `idea-b` to the two
  ChatGPT accounts through role capabilities. Compare it with the Claude/Codex
  default on real briefs, judged by the Sonnet evaluator (B3's method).


### WW — Website Workers that work, built with Website Workers (branch `web-workers`)

Merged into `dev` on 2026-11-09 by the operator's decision, with the canary
at 94% (47 of 50 at Power Medium, verifier `citations-v2`, both Accounts):
every failure was the model leaving out an output block, none a UI stage or
a verifier rejection. Its detail is in the branch's history (PLAN.md at
`6af50a7`). What it gave: Runtime `web` with `site: chatgpt` and Accounts
`web/chatgpt/<name>`, generic Procedures on a UI map (the legacy driver
removed), Power by tier, a circuit breaker per Account, the canary, the
`citations-v2` verifier, and the Workflows `second-opinion`, `debate`,
`brainstorm` on web Accounts and `research-fanout`. Left open:
- the model leaving out an output block (about 6%): the automatic fresh
  attempt is a DF Work after DF0b; a repair turn in the same chat was
  proposed (WW6m), not decided;
- `tests/chatgpt-web.test.ts` flaky under load: its failure now names the
  registration's reason (WW6l), the cause is not reproduced yet;
- deferred by measurement: a long-lived Chrome per Account (step 3), with
  the operator's open questions; a second Site; `digest`.


## 4. Future, not current gates

- [ ] Publishing for other repositories (operator, 2026-11-08; right after
  DF): each repository names its branches beside its checks (`.system/`,
  pinned from the base commit); the Host keeps the allowlist of branches it
  may merge into, since that is authority a repository cannot grant itself.
  Until then, a Work on another repository ends at its checked change.

- [ ] An Orchestrator that System spawns on a schedule (after O).
- [ ] Research quality capabilities (source snapshots, citation consistency,
  claim-to-evidence checking) as separately selected verifiers. *Trigger: a
  Research Work whose accepted report the operator finds wrong because a
  source changed or a claim was not supported. Until then, V1's ratio policy
  (unconfirmed quotes are listed, not hidden) is the bar (2026-11-06).*
- [ ] Source fetching and snapshots with content identity (the Website
  Worker's layer 2), with the trigger above.
- [ ] Optional Skill, LSP, web-fetch or another Worker adapter only if a Work
  fails for want of one and the pinned DSH plugin can satisfy the System
  contract without duplicating the model loop.
- [ ] Adaptive routing only on a measured need, such as quota exhaustion.
