# System

System is a durable control plane for delegated work. One operator hands
work to AI agents, and System keeps a record of what was asked, what came
back, and what was checked.

## Language

### Workers

**Runtime**:
An agent program that System runs to do a step, such as Claude Code or
Codex, or the `web` Runtime, which drives a signed-in Site in a browser.
_Avoid_: agent, engine, tool

**Account**:
One quota of a signed-in identity of a Runtime, with its credential and the
capabilities the profile gives it. Two Accounts never share one quota; when a
Provider gives one sign-in several quotas (Antigravity: one for Gemini models,
one for Claude and GPT models), each quota is its own Account, limited to the
models that quota covers.
_Avoid_: login, user, key

**Headroom**:
The share of an Account's quota left in its fuller window (5-hour or
weekly); work goes to the Account with the most Headroom, and no Account
of a Runtime is preferred by name.
_Avoid_: capacity, remaining

**Ceiling**:
The share of a quota window above which an Account takes no new step.
_Avoid_: limit, threshold

**Outside failure**:
A failure, hold or operator touch of a Work caused by its surroundings (machine load, an Account's quota, a Host restart, a conflict with other work, a slow Host), not by its change. A failure whose cause System cannot place is none of the three kinds (an Outside failure, a Process failure, a failure of the change): its cause is unknown.
_Avoid_: infra error, flake (a flake is one kind)

**Process failure**:
A failure caused by System itself - its Workflow, a Verifier, a Runtime adapter, its install, or the caller's Task - not by the change and not by its surroundings. Examples: a Task that asks for `[verified]` tags the citation check rejects; a Verifier reading `?.[1]` inside code as a source id; a Runtime keeping a code block's "JSON" label in an output; "no change" after a correct change because `rerunUnchanged` was off; a retry from an already-finished base; an install repository that fetched only main.
_Avoid_: system error, internal error

**Worker**:
An Account registered with System to run steps. A Worker is never a model.
_Avoid_: agent, model, bot

**Provider**:
The company that holds an Account's sign-in and quota, such as Anthropic,
OpenAI or Google. The models a Runtime serves may come from other companies;
who made a model is a property of the model, not of the Account.
_Avoid_: vendor, Worker, model maker

**Tier**:
A capability that selects how capable a model a Worker uses for a step:
economy, standard or frontier.
_Avoid_: model size, level

**Ability**:
A capability that says what an Account's Runtime can do, such as write to a
repository checkout or browse a site; declared by the Runtime, not granted
per Account.
_Avoid_: permission, feature

**Role**:
A capability naming a step's part in a Workflow, given to one or more Accounts so
that the step runs on that Account, such as the first Brainstorm proposal or
the development of a code change (`develop.implement`). A step's `prefer` names a role that ranks its Accounts first without requiring them, falling back to any other capable Account.
_Avoid_: persona, agent type

### Running and directing work

**Authority**:
Who may call an operation: the Operator at a terminal (approve, deny, verify
again, release), a caller session (submit, claim, store an Intent), or a
Worker (no Host operation: it only writes its outputs). Declared once for
each operation. The Operator may delegate release to a caller session.
_Avoid_: permission, role (a Role is a Workflow capability), scope

**Operator**:
The one person a System install works for: they own its profile and
repositories, write Items, approve, deny and release. They may run System on
more than one machine.
_Avoid_: user, admin, team

**Intent**:
What the operator wants, settled with a caller session and stored as an Artifact before any Item carries it out. It says the outcome and why, and is not itself checkable; the Items made from it name it, so every result can be traced back to what was wanted. A changed Intent is a new Intent.
_Avoid_: idea, prompt, request

**Item**:
A planned piece of a project's work, with a stable ID in the project's
status list. An Item can get several Tasks over time (a request rewritten
after a failure); Works carry them out, and the change that finishes it
marks it done. The Item's line is the brief: it names its files, its
tests and what shows it is done, and is the Task's instructions.
_Avoid_: task, ticket, issue, todo

**Claim**:
A session's notice that it drives an Item before any Work for it exists; a
Work for the Item takes it over. It never expires: it ends only when taken
over, by that Work or by another session that claims the Item anyway.
_Avoid_: lock, lease, assignment

**Idle**:
An Item that is claimed or in progress while no Work for it runs or waits;
shown by `status`, never ended by System.
_Avoid_: stale, abandoned, expired

**Ready**:
An Item not yet done whose every Item it comes after is done; the Items a
session may pick next.
_Avoid_: available, unblocked, eligible

**Blocked**:
An Item not yet done that comes after an Item still not done. Read from the
status list, never recorded. `after:` names a real dependency, never a priority;
priority is the order of the status list.
_Avoid_: waiting, held (a held Work awaits an Approval)

**Task**:
An immutable record of what to do: instructions, optionally the repository
commit to start from, and Artifacts to read as context. A Task does not run;
the Task of an Item is the Item's line; several Works can take the same Task.
_Avoid_: job, ticket, Work (for the request)

**Work**:
One durable carrying-out of a Task through a pinned Workflow, with its
attempts, verdicts and record; cancel, retry and approve act on a Work.
_Avoid_: run, job, Task (for the execution)

**Workflow**:
A named, versioned spec of the steps that carry out a Task and how a failed
step reopens an earlier one; a Work pins one when it is admitted. See
[workflow composition](docs/architecture/workflow-composition.md) and
[ADR-0002](docs/decisions/ADR-0002-work-primitive-configured-workflows.md).
_Avoid_: pipeline, recipe, template

**Step**:
One unit of a Workflow, run as one or more attempts: a Worker step, a
verify step or an effect step, each naming the capabilities it needs.
_Avoid_: stage, phase; task (a Task is the request)

**Attempt**:
One execution of a step by one Account, recorded in the Work's history. A
failed or lost step runs again as a new Attempt; the earlier ones stay in the
record. See [work-record](docs/architecture/work-record.md).
_Avoid_: run, try, retry (a retry acts on a Work)

**Attempt log**:
What the Runtime printed during one Attempt, stored as an Artifact with secrets
removed: the record of what the Worker did, read when an Attempt has to be
understood afterwards.
_Avoid_: session (a caller session), transcript, Conversation (brought in by the operator)

**Artifact**:
An immutable, typed, content-addressed record, such as a Task's context file, an
Intent or a step's output; its ID is derived from its kind and content, so equal
content is one Artifact. See [the artifacts package](packages/artifacts/README.md) and
[ADR-0003](docs/decisions/ADR-0003-artifact-ids-and-verification-contracts.md).
_Avoid_: file, blob, output (an output is one use of an Artifact)

**Check**:
A step of a Workflow that runs Verifiers on a Worker step's output and
records a Verdict for each; a Work goes on only on a pass.
_Avoid_: test (a test is one thing a Check may run), gate

**Effect**:
An external change a Workflow makes to the world, such as merging a commit,
done by an effect step only after every required Verdict on the exact subject
is pass; recorded as intended, then as observed, and never retried blindly.
_Avoid_: side effect, action, deploy

**Hold**:
A Work stopped at a step until a human decides: it awaits an Approval, or an
inconclusive Verdict the operator must resolve. A hold is not a failure.
_Avoid_: pause, block (a Blocked Item awaits other Items), wait (a Quota wait needs no human)

**Sub-workflow**:
A Workflow used as one step of another Workflow; its steps are joined into
the using Workflow's spec when the Work is admitted.
_Avoid_: child Work, nested run, subroutine

**Approval**:
A human's yes or no on what a held Work awaits; the only one of these that
lets a Work go on.
_Avoid_: decision, sign-off

**Gate path**:
A path whose change is held for the Operator's Approval of that commit after
its checks pass, instead of merging. A change cannot lift a Gate path for
itself.
_Avoid_: protected path, code owner; gate alone (it also names the Aim and a
threshold a measure must pass)

**Quota wait**:
A running Work whose next step waits for an Account's quota to reset;
recorded with the time it expects to go on. Not a hold: no human is needed.
_Avoid_: waiting, paused, blocked

**Stall**:
A running attempt that has reported nothing for longer than the Host allows;
a notice to look, never a verdict, and the attempt goes on.
_Avoid_: timeout, hang, failure

**Host**:
The one long-lived System process on a machine that owns every Work; the
CLI and agents act on Work only by asking it.
_Avoid_: daemon, server, backend

**Release**:
Merging one commit of `dev` into `main` and installing it, after the operator
read its release report or approved that commit. System prepares a Release but
never decides one.
_Avoid_: deploy, ship; checkpoint (a milestone's internal gate)

**Batch**:
The Items under one Intent that are run and then released once. The operator
accepts a Batch in one act and notes the product's own measure before and after
it.
_Avoid_: lot, sprint; merge group (changes a merge queue checks together)

**Scheduled session**:
A caller session started on a schedule, with no operator present, that picks
Ready Items and carries them through Works within fixed limits; it never
approves or writes Items, and it releases only a commit the Operator approved.
_Avoid_: night run, night session, bot, autopilot

**Schedule** ([ADR-0020](docs/decisions/ADR-0020-the-scheduled-session-is-a-deterministic-caller.md)):
What the Operator writes down on one machine for a Scheduled session: when it
starts and what it carries, either the Ready Items of named repositories or one
Work from a fixed Workflow and Task.
_Avoid_: job (a Task is the request), cron, routine

### Checking work

**Verifier**:
A check System runs on one exact Artifact against pinned criteria. It is
not a Worker and never changes what it checks.
_Avoid_: reviewer, judge, validator

**Verdict**:
What a Verifier concludes about one Artifact: pass; fail, when the Artifact
itself is wrong (such as malformed); or inconclusive, when the check could
not confirm it against the world (a page that changed or refused the fetch,
or a check that the base fails too, after one re-run on the change and the base, so the change cannot be to blame; or a check that fails twice on the same change after `implement` changed nothing).
Only a check of the Artifact's own form may fail it.
_Avoid_: score, review, result

**Classifier**:
Answers one closed question about an Artifact; not a Verifier and never a
ground for acceptance.
_Avoid_: judge, decision

**Classification**:
A Classifier's recorded answer: label, label distribution, confidence, model and
question version.
_Avoid_: verdict, decision

**Triage** (specified, not built; [ADR-0013](docs/decisions/ADR-0013-models-decide-what-to-try.md)):
Writes a diagnosis of a failed step, as an Artifact, for the step that is
reopened and for the operator; never accepts, verifies again or changes what
the controller does.
_Avoid_: judge, brain, agent

**Model check** (specified, not built; [ADR-0014](docs/decisions/ADR-0014-checks-in-tiers-by-event.md)):
A Verifier backed by a model whose Verdict can only be fail or inconclusive,
never pass; runs in shadow until its precision is measured.
_Avoid_: AI review, judge

**Satisfied**:
A Work's outcome when its Item already holds at the Task's base, shown by a
test that a Verifier ran there; nothing is merged and the Item counts as done.
_Avoid_: no-op, skipped, already done

**Escaped defect**:
A defect in a change that passed its checks and was accepted, found later by
review or use.
_Avoid_: false positive, regression

**Recurring failure**:
A failure that an earlier Work already had: the same check failing on the
same first test, or the same Outside cause. Two failures of one step are not
the same failure for that alone.
_Avoid_: repeat, regression

**Guardrail**:
An enforced check (a test, a type, a lint rule, an API or a verifier) added
because a defect escaped or a failure recurred, shown to block that defect.
_Avoid_: rule, guideline, reminder

### Outside material

**Conversation**:
An exchange the operator had elsewhere, such as in a web chat product, that
the operator brings into System. System vouches for the bytes, never for
where they came from or whether they are true.
_Avoid_: chat log, transcript, Website Worker output

**Website Worker**:
A Worker that System drives on a website where the operator is signed in.
_Avoid_: browser agent, conversation import

**Site**:
A web product a Website Worker uses, such as chatgpt.com; each Site belongs to
a Provider.
_Avoid_: provider (for the product), website type

**UI map**:
The configuration of one Site: its elements, its page states, and how each
Procedure is done on its interface. A new Site is a new UI map, not new code.
_Avoid_: selectors file, driver

**Procedure**:
An operation every Site has, such as opening a chat, sending, waiting for the
answer or reading it; the UI map says how it is done on a given Site.
_Avoid_: action, step (a step is part of a Workflow)
