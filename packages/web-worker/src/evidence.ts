/**
 * The evidence record of one `chatgpt-web` attempt (WW1): a small JSON file made before Chrome
 * launches and rewritten, atomically, at every stage start and end, so a failed or killed attempt
 * still shows which stage it reached. The Runtime stores it as the attempt's partial output (and
 * in its log), where System's records keep it. It holds counts, times and versions: no cookie,
 * token, prompt or answer text.
 */
import { renameSync, writeFileSync } from 'node:fs'

export interface StageRecord {
  stage: string
  status: 'started' | 'ok' | 'failed'
  /** Milliseconds from the start of the attempt. */
  startedMs: number
  elapsedMs?: number
  /** The first line of the failure. */
  error?: string
}

export interface EvidenceData {
  schema: 'chatgpt-web-evidence@1'
  attempt: string
  account: string
  /** Chrome's version as the Account reports it. */
  chrome: string | undefined
  uiMap: { revision: string; hash: string }
  /** The page logic that ran the attempt: System 1's ChatGPT driver, or the generic Procedures (WW2-iii). */
  procedures: 'legacy' | 'generic'
  launchTimeoutSeconds: number
  viewport?: { width: number; height: number }
  /** The pages Chrome came up with, how many were open before the first navigation, and how many were confirmed closed since (inherited, then late), and how many late ones would not close. */
  pages?: { initial: number; beforeNavigation: number; closedInherited: number; closedLate: number; closeFailed: number }
  /** True from the moment the send is attempted: a click that threw may still have sent, so a retry must not assume it did not. */
  promptSendAttempted: boolean
  /** True only once the page shows a user turn for the prompt: the site has it. False with `promptSendAttempted` is unknown, not "not sent". */
  promptSubmitted: boolean
  /** What the site made of the prompt's body: text in the composer, or attachment chips and how many; none for a one-part prompt. */
  attach?: { outcome: 'text' | 'attachment'; chips: number }
  /** How each required output was filled: from the rendered block that carries its name, the Markdown text, or (the site showed the fences as text, its Copy escaped them) the answer's rendered text (WW5d). */
  filled?: Record<string, 'block' | 'text' | 'rendered'>
  /** Per output, each leaked token removed from its edges, once per removal (WW6b: the UI map's `answer.leakedTokens`); only outputs that had one. */
  stripped?: Record<string, string[]>
  /** Characters of the answer outside its output blocks, whitespace ignored (WW5c). */
  outsideChars?: number
  /** How the wait for the answer ended: it finished, the site showed its own error in its place, or the time ran out (WW6a). */
  waitEnded?: 'done' | 'site error' | 'timeout'
  /** True when the newest answer held the site's own error ("This response couldn’t load"): sent, nothing answered. */
  siteError?: true
  stages: StageRecord[]
  lastCompleted?: string
  failedStage?: string
  /** Why the page could not be captured, when it could not (the original failure is the stage's). */
  diagnosticsError?: string
}

export interface Evidence {
  data: EvidenceData
  begin(stage: string): void
  end(stage: string, error?: string): void
  /** Merge facts and write the file. */
  set(facts: Partial<EvidenceData>): void
  json(): string
}

export function createEvidence(file: string, initial: Omit<EvidenceData, 'schema' | 'promptSendAttempted' | 'promptSubmitted' | 'stages'>, now: () => number = Date.now): Evidence {
  const origin = now()
  const data: EvidenceData = { schema: 'chatgpt-web-evidence@1', ...initial, promptSendAttempted: false, promptSubmitted: false, stages: [] }
  const flush = (): void => {
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 })
      renameSync(`${file}.tmp`, file)
    } catch {
      // The record is also kept in memory and stored at the end; a full disk must not end the attempt.
    }
  }
  flush()
  return {
    data,
    begin(stage) {
      // A stage that runs again (the same name twice) is one stage, not two.
      if (!data.stages.some((s) => s.stage === stage)) data.stages.push({ stage, status: 'started', startedMs: now() - origin })
      flush()
    },
    end(stage, error) {
      const record = data.stages.find((s) => s.stage === stage)
      if (record) {
        record.status = error === undefined ? 'ok' : 'failed'
        record.elapsedMs = now() - origin - record.startedMs
        if (error !== undefined) record.error = error
      }
      if (error === undefined) data.lastCompleted = stage
      else data.failedStage ??= stage
      flush()
    },
    set(facts) {
      Object.assign(data, facts)
      flush()
    },
    json: () => JSON.stringify(data),
  }
}
