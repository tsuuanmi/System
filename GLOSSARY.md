# System

System is a durable control plane for delegated work. One operator hands
work to AI agents, and System keeps a record of what was asked, what came
back, and what was checked.

## Language

### Workers

**Runtime**:
An agent program that System runs to do a step, such as Claude Code or
Codex.
_Avoid_: agent, engine, tool

**Account**:
One signed-in identity of a Runtime, with its own credential and the
capabilities the profile gives it.
_Avoid_: login, user, key

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
that the step runs on that Account, such as the first Brainstorm proposal.
_Avoid_: persona, agent type

### Running and directing work

**Host**:
The one long-lived System process on a machine that owns every Work; the
CLI and agents act on Work only by asking it.
_Avoid_: daemon, server, backend

**Orchestrator**:
An agent that directs Work toward a Goal through System's agent interface,
with an agent's authority: it may submit, run, cancel and retry Work, but
never approve, accept or merge.
_Avoid_: leader, lead, manager, planner

**Goal**:
An aim the operator writes down, with its scope and budget, that an
Orchestrator works toward; every Work it creates names its Goal.
_Avoid_: project, charter, epic, campaign

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
