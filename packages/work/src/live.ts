/**
 * Live attempt progress (PROP-0006 decisions 3 and 4): what each running
 * Worker attempt last reported, in memory only, never an event. An attempt
 * quiet for `stallMinutes` is stalled once, until it reports again.
 */
import type { Progress } from './registry.ts'

/** How long an attempt may be quiet before it is reported stalled, by default. */
export const DEFAULT_STALL_MINUTES = 10

/** A running attempt as `work.show` reports it. */
export interface LiveAttempt {
  stepId: string
  attemptId: string
  worker: string
  startedAt: string
  lastActivityAt: string
  elapsedSeconds: number
  quietSeconds: number
  stalled: boolean
  /** Set when the step has not started: what it waits for (`a check slot`, or `quota`: every capable Account is over its ceiling); `attemptId` is then empty. */
  waiting?: 'a check slot' | 'quota'
  /** With `waiting: 'quota'`: the earliest time a reading says an Account is free again, if it says. */
  until?: string
  /** What the Runtime last reported: absent until it reports. */
  progress?: Progress
}

interface Entry {
  workId: string
  stepId: string
  attemptId: string
  worker: string
  started: number
  active: number
  stalled: boolean
  progress?: Progress
  timer?: NodeJS.Timeout
}

export class LiveAttempts {
  private readonly entries = new Map<string, Entry>()
  private readonly stallMs: number
  private readonly onStall: (workId: string) => void

  constructor(stallMinutes: number, onStall: (workId: string) => void) {
    this.stallMs = stallMinutes * 60_000
    this.onStall = onStall
  }

  /** An attempt starts: returns what its Worker calls to report progress. */
  start(attempt: { workId: string; stepId: string; attemptId: string; worker: string }): (progress: Progress) => void {
    const entry: Entry = { ...attempt, started: Date.now(), active: Date.now(), stalled: false }
    this.entries.set(attempt.attemptId, entry)
    this.arm(entry)
    return (progress) => {
      if (this.entries.get(attempt.attemptId) !== entry) return
      entry.progress = { ...progress }
      entry.active = Date.now()
      entry.stalled = false
      this.arm(entry)
    }
  }

  /** The attempt reported: it is no longer live. */
  end(attemptId: string): void {
    clearTimeout(this.entries.get(attemptId)?.timer)
    this.entries.delete(attemptId)
  }

  of(workId: string): LiveAttempt[] {
    const now = Date.now()
    return [...this.entries.values()].filter((e) => e.workId === workId).map((e) => ({
      stepId: e.stepId, attemptId: e.attemptId, worker: e.worker,
      startedAt: new Date(e.started).toISOString(), lastActivityAt: new Date(e.active).toISOString(),
      elapsedSeconds: Math.round((now - e.started) / 1000), quietSeconds: Math.round((now - e.active) / 1000),
      stalled: e.stalled, ...(e.progress ? { progress: e.progress } : {}),
    }))
  }

  private arm(entry: Entry): void {
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.stalled = true
      this.onStall(entry.workId)
    }, this.stallMs)
    // A stall timer never keeps the process alive by itself.
    entry.timer.unref()
  }
}
