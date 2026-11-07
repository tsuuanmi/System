/**
 * Goals (ADR-0009 decisions 1 and 2): a `goal@1` is immutable, a raise is a
 * new one that supersedes it, and its spend is never stored: it is folded
 * from the Works whose `admitted` event names the Goal or a Goal it
 * supersedes, so replay reproduces it exactly.
 */
import { fileURLToPath } from 'node:url'
import type { Artifacts } from '@system/artifacts'
import { WorkError } from './errors.ts'
import { DECISION_KIND, GOAL_KIND, TASK_KIND, taskSchema, type Goal, type RecordedDecision } from './kinds.ts'
import { TERMINAL, type Caller, type WorkRecord } from './record.ts'
import { summarize } from './summary.ts'

/** The Charter, the default context of a Goal; stored as a file Artifact when the Goal is created. */
export const CHARTER_PATH = fileURLToPath(new URL('../../../docs/requirements/purpose.md', import.meta.url))

/** A stored Goal: its content, the Goals it supersedes and when it was stored. */
export interface StoredGoal {
  goal: Goal
  supersedes: string[]
  at: string
}

/** The Artifact operations Goals need. */
export interface GoalStore {
  /** The Goal with this ID, or undefined when no `goal@1` is stored under it. */
  get(id: string): StoredGoal | undefined
  /** The Goals that directly supersede `id`. */
  successors(id: string): string[]
  /** Store a `task@1` like `task` with `context` added to its own: its ID. */
  wrapTask(task: string, context: string[], caller: Caller): Promise<string>
  /** Store a `decision@1` by `caller`, after the latest decision of its Goal's chain: its ID. */
  decide(decision: NewDecision, caller: Caller): Promise<{ id: string }>
  /** The decisions of the Goals in `chain` (all without it), oldest first. */
  decisions(chain?: ReadonlySet<string>): StoredDecision[]
}

/** A decision as it is asked for: its author and its place in the order are the store's. */
export type NewDecision = Omit<RecordedDecision, 'by' | 'previous'>

/** A stored decision, its ID and when it was stored. */
export type StoredDecision = RecordedDecision & { id: string; at: string }

/** What a Goal's Works have spent. Tokens are fresh input, cache writes and output; an attempt with unknown usage adds none. */
export interface Spend {
  works: number
  attempts: number
  tokens: number
  unknownAttempts: number
  /** Attempts that did not split their cache use: their fresh input is not known, so only their output counts. */
  unsplitAttempts: number
}

/** A Goal, its current version (the newest that supersedes it) and the spend of the whole chain. */
export interface GoalView {
  id: string
  goal: Goal
  current: { id: string; goal: Goal }
  spend: Spend
}

/** The spend of the Works admitted for any Goal in `goals`, folded from their events. */
export function spendOf(records: readonly WorkRecord[], goals: ReadonlySet<string>): Spend {
  const spend: Spend = { works: 0, attempts: 0, tokens: 0, unknownAttempts: 0, unsplitAttempts: 0 }
  for (const record of records) {
    const admitted = record.events[0]
    if (admitted?.type !== 'admitted' || !admitted.goal || !goals.has(admitted.goal)) continue
    const { attempts, usage } = summarize(record)
    spend.works += 1
    // A Work still to run or running is at least one attempt, so admitting cannot outrun the budget.
    spend.attempts += TERMINAL.has(record.state.status) ? attempts : Math.max(attempts, 1)
    spend.tokens += usage.freshInputTokens + usage.cacheWriteTokens + usage.outputTokens
    spend.unknownAttempts += usage.unknownAttempts
    spend.unsplitAttempts += usage.unsplitAttempts
  }
  return spend
}

/** Why a Goal's budget is used up, or undefined while there is room. */
export function overBudget(budget: Goal['budget'], spend: Spend): string | undefined {
  if (budget.attempts !== undefined && spend.attempts >= budget.attempts) return `${spend.attempts} of ${budget.attempts} attempts spent`
  if (budget.tokens !== undefined && spend.tokens >= budget.tokens) return `${spend.tokens} of ${budget.tokens} tokens spent`
  return undefined
}

/** Resolve `id` to its current version, and the IDs of every Goal in the chain that ends there. */
export function resolveGoal(store: GoalStore, id: string): { view: Omit<GoalView, 'spend'>; chain: Set<string> } {
  const first = store.get(id)
  if (!first) throw new WorkError(`no Goal ${id}`)
  let current = { id, ...first }
  for (;;) {
    // A raise supersedes only the newest version, so the chain is linear; the latest stored wins if a store holds a branch anyway.
    const next = store.successors(current.id).map((successorId) => ({ id: successorId, ...store.get(successorId)! }))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1))[0]
    if (!next) break
    current = next
  }
  const chain = new Set<string>()
  const walk = (goalId: string) => {
    if (chain.has(goalId)) return
    chain.add(goalId)
    for (const parent of store.get(goalId)?.supersedes ?? []) walk(parent)
  }
  walk(current.id)
  return { view: { id, goal: first.goal, current: { id: current.id, goal: current.goal } }, chain }
}

/** Each after its `previous`; among those ready, the earlier stored first. */
function inOrder(decisions: StoredDecision[]): StoredDecision[] {
  const left = [...decisions].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1))
  const placed = new Set<string>()
  const ordered: StoredDecision[] = []
  while (left.length) {
    const at = Math.max(0, left.findIndex((d) => !d.previous || placed.has(d.previous) || !left.some((o) => o.id === d.previous)))
    const [next] = left.splice(at, 1)
    placed.add(next!.id)
    ordered.push(next!)
  }
  return ordered
}

/** Goals over the Artifact store. */
export function goalStore(artifacts: Artifacts): GoalStore {
  // Decisions are recorded one at a time, so each names the one before it.
  let deciding: Promise<unknown> = Promise.resolve()
  const store: GoalStore = {
    get(id) {
      const read = artifacts.get(id)
      if (read.state !== 'stored' || read.envelope.kind !== GOAL_KIND.kind || read.envelope.schemaVersion !== GOAL_KIND.schemaVersion) return undefined
      return { goal: read.envelope.content as Goal, supersedes: read.envelope.lineage.supersedes ?? [], at: read.envelope.createdAt }
    },
    successors: (id) => artifacts.supersededBy(id).filter((found) => store.get(found)),
    async wrapTask(task, context, caller) {
      const read = artifacts.get(task)
      if (read.state !== 'stored' || read.envelope.kind !== TASK_KIND.kind) throw new WorkError(`a Goal's Work needs a task@1 input, not ${task}`)
      const content = taskSchema.parse(read.envelope.content)
      const merged = [...new Set([...context, ...(content.context ?? [])])]
      if (merged.length > 16) throw new WorkError(`the Goal's context and the Task's make ${merged.length} Artifacts; a Task takes 16`)
      return (await artifacts.put({
        ...TASK_KIND, content: { ...content, context: merged }, inputs: [...(content.base ? [content.base] : []), ...merged],
        classification: 'local-private', producer: { type: 'operator', ref: caller.operatorId },
      })).id
    },
    decide(decision, caller) {
      const record = async () => {
        const { chain } = resolveGoal(store, decision.goal)
        if (!decision.options.includes(decision.choice)) throw new WorkError(`the choice ${decision.choice} is not one of the options: ${decision.options.join(', ')}`)
        const previous = store.decisions(chain).at(-1)?.id
        const stored = await artifacts.put({
          ...DECISION_KIND, content: { ...decision, by: caller, ...(previous ? { previous } : {}) },
          inputs: [decision.goal, ...decision.restsOn, ...(previous ? [previous] : [])],
          classification: 'operator-shared', producer: { type: 'operator', ref: caller.operatorId },
        })
        return { id: stored.id }
      }
      const done = deciding.then(record, record)
      deciding = done.catch(() => {})
      return done
    },
    decisions(chain) {
      return inOrder(artifacts.ofKind(DECISION_KIND.kind)
        .filter((e) => e.schemaVersion === DECISION_KIND.schemaVersion)
        .map((e) => ({ ...(e.content as RecordedDecision), id: e.id, at: e.createdAt }))
        .filter((d) => !chain || chain.has(d.goal)))
    },
  }
  return store
}
