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
One signed-in identity of a Runtime, with its own credential and the
capabilities the profile gives it. Each Account is a distinct account of its
Provider, so two Accounts never share one quota.
_Avoid_: login, user, key

**Primary Account**:
The Account of a Runtime that takes a step first while it is under the
Ceiling; the other Accounts of the Runtime are secondary.
_Avoid_: main account, default account

**Headroom**:
The share of an Account's quota left in its fuller window (5-hour or
weekly); work goes to the Account with the most Headroom.
_Avoid_: capacity, remaining

**Ceiling**:
The share of a quota window above which an Account takes no new step.
_Avoid_: limit, threshold

**Outside failure**:
A failure, hold or operator touch of a Work caused by its surroundings (machine load, an Account's quota, a Host restart, a conflict with other work, a slow Host), not by its change.
_Avoid_: infra error, flake (a flake is one kind)

**Worker**:
An Account registered with System to run steps. A Worker is never a model.
_Avoid_: agent, model, bot

**Provider**:
The company whose models a Runtime uses, such as Anthropic or OpenAI.
_Avoid_: vendor, Worker

**Tier**:
A capability that selects how capable a model a Worker uses for a step:
economy, standard or frontier.
_Avoid_: model size, level

**Role**:
A capability naming a step's part in a Workflow, given to one Account so
that the step runs on that Account, such as the first Brainstorm proposal or
the development of a code change (`code.develop`).
_Avoid_: persona, agent type

### Running and directing work

**Item**:
A planned piece of a project's work, with a stable ID in the project's
status list; Works carry it out, and the change that finishes it marks it
done.
_Avoid_: task, ticket, issue, todo

**Claim**:
A session's notice that it drives an Item before any Work for it exists; a
Work for the Item takes it over.
_Avoid_: lock, lease, assignment

**Task**:
An immutable record of what to do: instructions, optionally the repository
commit to start from, and Artifacts to read as context. A Task does not run;
several Works can take the same Task.
_Avoid_: job, ticket, Work (for the request)

**Work**:
One durable carrying-out of a Task through a pinned Workflow, with its
attempts, verdicts and record; cancel, retry and approve act on a Work.
_Avoid_: run, job, Task (for the execution)

**Sub-workflow**:
A Workflow used as one step of another Workflow; its steps are joined into
the using Workflow's spec when the Work is admitted.
_Avoid_: child Work, nested run, subroutine

**Approval**:
A human's yes or no on what a held Work awaits; the only one of these that
lets a Work go on.
_Avoid_: decision, sign-off

**Stall**:
A running attempt that has reported nothing for longer than the Host allows;
a notice to look, never a verdict, and the attempt goes on.
_Avoid_: timeout, hang, failure

**Host**:
The one long-lived System process on a machine that owns every Work; the
CLI and agents act on Work only by asking it.
_Avoid_: daemon, server, backend

**Round**:
One pass of a Debate in which each side answers having read the other
sides' answers of the previous Round.
_Avoid_: turn, iteration

**Debate**:
A Workflow of several Rounds between independent Workers, ended by a
synthesis; the number of Rounds is fixed in the Workflow.
_Avoid_: discussion, conversation (a Conversation is outside material)

**Lane**:
One of the k parallel branches of a fan-out Workflow, each on a capability of its
own so that a profile gives it to its own Account; k is fixed in the Workflow.
_Avoid_: track, thread, branch (a branch is a git term)

**Release**:
The operator merging `dev` into `main` after reading a release report. System
never makes a Release.
_Avoid_: deploy, ship; checkpoint (a milestone's internal gate)

### Checking work

**Verifier**:
A check System runs on one exact Artifact against pinned criteria. It is
not a Worker and never changes what it checks.
_Avoid_: reviewer, judge, validator

**Verdict**:
What a Verifier concludes about one Artifact: pass; fail, when the Artifact
itself is wrong (such as malformed); or inconclusive, when the check could
not confirm it against the world (a page that changed or refused the fetch,
or a check that the base fails too, after one re-run on the change and the base, so the change cannot be to blame; or a check that fails twice on the same change after `implement` changed nothing, sc-9).
Only a check of the Artifact's own form may fail it.
_Avoid_: score, review, result

### Outside material

**Conversation**:
An exchange the operator had elsewhere, such as in a web chat product, that
the operator brings into System. System vouches for the bytes, never for
where they came from or whether they are true.
_Avoid_: chat log, transcript, Website Worker output

**Source snapshot**:
A public source that System itself fetched and stored, identified by its
content.
_Avoid_: citation, scrape

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
