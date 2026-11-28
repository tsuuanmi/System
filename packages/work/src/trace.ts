/**
 * Item trace-1: reconstruct what happened to a Work, in order, from its stored
 * events and Artifacts (`check-run`, Attempt logs) with no model.
 */
import type { WorkEvent, WorkRecord } from './record.ts'

export interface TraceStore {
  artifact(id: string): { state: string; envelope?: { kind?: string; content?: unknown; blob?: { bytes: number } } } | undefined
  readBytes(id: string): Promise<Uint8Array>
}

export interface AttemptLogTrace {
  id: string
  size: number
  commands?: string[]
  filesRead?: string[]
  filesWritten?: string[]
  finalStatement?: string
}

export interface FailedCheckTrace {
  id: string
  name: string
  run: string
  commit: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  leftovers?: string[]
  stdoutTail: string
  stderrTail: string
}

export type TraceEntry =
  | {
      kind: 'attempt'
      stepId: string
      attemptId: string
      account: string
      model?: string
      startedAt: string
      endedAt?: string
      durationMs?: number
      status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'lost'
      reason?: string
      usage?: Extract<WorkEvent, { type: 'observed' }>['usage']
      inputs?: Record<string, string>
      outputs?: Record<string, string>
      log?: AttemptLogTrace
    }
  | {
      kind: 'verdict'
      stepId: string
      attemptId: string
      at: string
      verdict: 'pass' | 'fail' | 'inconclusive' | 'error'
      reason: string
      subject: string
      verdictId?: string
      verifier?: { ref: string; version: string }
      rerunOf?: string
      failedChecks: FailedCheckTrace[]
    }
  | {
      kind: 'reopened'
      stepId: string
      at: string
      reason: string
      automatic: boolean
      caller?: { type: string; operatorId: string }
      previous?: string
      failure?: string
      failedEffect?: string
      base?: string
      worker?: string
      reset?: string[]
    }
  | {
      kind: 'effect'
      stepId: string
      operationId: string
      capability?: string
      subject?: string
      provider?: { ref: string; version: string }
      intendedAt?: string
      observedAt?: string
      state: 'intended' | 'applied' | 'failed' | 'absent' | 'unknown'
      reason?: string
      detail?: Record<string, string>
      rejected?: 'conflict' | 'merge-check' | 'build-output'
      held?: string
    }
  | {
      kind: 'decided'
      stepId: string
      at: string
      decision: 'approved' | 'denied'
      reason: string
      caller: { type: string; operatorId: string }
    }
  | {
      kind: 'skipped'
      stepId: string
      at: string
      reason: string
    }
  | {
      kind: 'waiting'
      stepId: string
      at: string
      cause: 'quota'
      resetsAt?: string
    }
  | {
      kind: 'terminal'
      at: string
      outcome: 'succeeded' | 'failed' | 'held' | 'cancelled'
      reason: string
      results: Record<string, string>
      result?: 'satisfied'
      awaiting?: string
      hold?: 'approval' | 'inconclusive'
    }

export interface WorkTrace {
  id: string
  status: WorkRecord['state']['status']
  specId: string
  item?: { id: string; repository?: string }
  admittedAt: string
  timeline: TraceEntry[]
  outcome?: Extract<TraceEntry, { kind: 'terminal' }>
}

const WRITE_TOOLS_CLAUDE = new Set(['Edit', 'Write', 'MultiEdit'])
const WRITE_TOOLS_AGY = new Set(['write_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content'])

function formatStructuredText(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { status?: unknown; reason?: unknown }
      if (parsed && typeof parsed.reason === 'string') {
        return typeof parsed.status === 'string' ? `${parsed.status}: ${parsed.reason}` : parsed.reason
      }
    } catch { /* plain text */ }
  }
  return trimmed
}

function parseAttemptLog(text: string): Omit<AttemptLogTrace, 'id' | 'size'> {
  const commands: string[] = []
  const read = new Set<string>()
  const written = new Set<string>()
  let claudeFinal: string | undefined
  let lastClaudeText: string | undefined
  let codexFinal: string | undefined
  let agyFinal: string | undefined
  let agyResponseIndex: unknown
  let agyResponseText = ''

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event: Record<string, any>
    try { event = JSON.parse(trimmed) } catch { continue }
    if (!event || typeof event !== 'object') continue

    // Claude Code: assistant tool_use blocks and result
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === 'tool_use' && typeof block.name === 'string') {
          if (block.name === 'Bash' && typeof block.input?.command === 'string') commands.push(block.input.command)
          else if (block.name === 'Read' && typeof block.input?.file_path === 'string') read.add(block.input.file_path)
          else if (WRITE_TOOLS_CLAUDE.has(block.name) && typeof block.input?.file_path === 'string') written.add(block.input.file_path)
        } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          lastClaudeText = block.text.trim()
        }
      }
    } else if (event.type === 'result') {
      if (event.structured_output && typeof event.structured_output === 'object' && typeof event.structured_output.reason === 'string') {
        const s = event.structured_output
        claudeFinal = typeof s.status === 'string' ? `${s.status}: ${s.reason}` : s.reason
      } else if (event.structured_output !== undefined) {
        claudeFinal = JSON.stringify(event.structured_output)
      } else if (typeof event.result === 'string' && event.result.trim()) {
        claudeFinal = formatStructuredText(event.result)
      }
    }

    // Codex: item.completed and turn.failed
    if (event.type === 'item.completed' && event.item && typeof event.item === 'object') {
      const item = event.item
      if (item.type === 'command_execution' && typeof item.command === 'string') commands.push(item.command)
      else if (item.type === 'file_change') {
        if (Array.isArray(item.changes)) {
          for (const change of item.changes) if (typeof change?.path === 'string') written.add(change.path)
        } else if (typeof item.path === 'string') {
          written.add(item.path)
        }
      } else if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
        codexFinal = formatStructuredText(item.text)
      }
    } else if (event.type === 'turn.failed' && typeof event.error?.message === 'string') {
      codexFinal = event.error.message
    }

    // Antigravity: step_update and result
    const step = event.step_update
    if (step && typeof step === 'object') {
      if (step.step_type === 'tool' && step.state !== 'ACTIVE') {
        const params = step.tool_info?.parameters
        if (step.tool_name === 'run_command' && typeof params?.CommandLine === 'string') commands.push(params.CommandLine)
        else if (step.tool_name === 'read_file' && typeof params?.Path === 'string') read.add(params.Path)
        else if (typeof step.tool_name === 'string' && WRITE_TOOLS_AGY.has(step.tool_name)) {
          const path = params?.Path ?? params?.TargetFile
          if (typeof path === 'string') written.add(path)
        }
      } else if (step.step_type === 'agent_response') {
        if (step.step_index !== agyResponseIndex) { agyResponseIndex = step.step_index; agyResponseText = '' }
        if (typeof step.text_delta === 'string') agyResponseText += step.text_delta
      }
    } else if (event.event === 'result' && event.result && typeof event.result === 'object') {
      if (typeof event.result.response === 'string' && event.result.response.trim()) agyFinal = formatStructuredText(event.result.response)
      else if (typeof event.result.error === 'string' && event.result.error.trim()) agyFinal = event.result.error.trim()
    }
  }

  const finalStatement = claudeFinal ?? codexFinal ?? agyFinal ?? (agyResponseIndex !== undefined && agyResponseText.trim() ? formatStructuredText(agyResponseText) : undefined) ?? lastClaudeText
  return {
    ...(commands.length ? { commands } : {}),
    ...(read.size ? { filesRead: [...read] } : {}),
    ...(written.size ? { filesWritten: [...written] } : {}),
    ...(finalStatement !== undefined ? { finalStatement } : {}),
  }
}

async function readAttemptLog(id: string, store: TraceStore): Promise<AttemptLogTrace | undefined> {
  const meta = store.artifact(id)
  if (!meta || meta.state !== 'stored') return undefined
  let size = meta.envelope?.blob?.bytes ?? 0
  let text: string
  try {
    const bytes = await store.readBytes(id)
    size = bytes.byteLength
    text = Buffer.from(bytes).toString('utf8')
  } catch {
    return { id, size }
  }
  const parsed = parseAttemptLog(text)
  const hasEvents = Boolean(parsed.commands?.length || parsed.filesRead?.length || parsed.filesWritten?.length || parsed.finalStatement !== undefined)
  return hasEvents ? { id, size, ...parsed } : { id, size }
}

function readFailedChecks(event: Extract<WorkEvent, { type: 'verified' }>, store: TraceStore): FailedCheckTrace[] {
  let ids = event.evidence ?? []
  if (!ids.length && event.verdictId) {
    const verdict = store.artifact(event.verdictId)
    if (verdict?.state === 'stored' && verdict.envelope?.content && typeof verdict.envelope.content === 'object') {
      const ev = (verdict.envelope.content as { evidence?: unknown }).evidence
      if (Array.isArray(ev)) ids = ev.filter((x): x is string => typeof x === 'string')
    }
  }
  const failed: FailedCheckTrace[] = []
  for (const id of ids) {
    const read = store.artifact(id)
    if (!read || read.state !== 'stored' || read.envelope?.kind !== 'check-run') continue
    const run = read.envelope.content as {
      name: string; run: string; commit: string; exitCode: number | null; signal: string | null
      timedOut: boolean; leftovers?: string[]; stdoutTail: string; stderrTail: string
    }
    if (run.exitCode === 0 && !run.timedOut && !run.leftovers?.length) continue
    failed.push({
      id,
      name: run.name,
      run: run.run,
      commit: run.commit,
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      ...(run.leftovers?.length ? { leftovers: run.leftovers } : {}),
      stdoutTail: run.stdoutTail,
      stderrTail: run.stderrTail,
    })
  }
  return failed
}

/** Reconstruct what happened to a Work, in order, from its events and stored Artifacts. */
export async function traceWork(record: WorkRecord, store: TraceStore): Promise<WorkTrace> {
  const first = record.events[0]!
  const admitted = first.type === 'admitted' ? first : undefined
  const observedByAttempt = new Map<string, Extract<WorkEvent, { type: 'observed' }>>()
  const lostByAttempt = new Map<string, Extract<WorkEvent, { type: 'attempt-lost' }>>()
  const effectObservedByOp = new Map<string, Extract<WorkEvent, { type: 'effect-observed' }>>()
  const pairedOps = new Set<string>()

  for (const event of record.events) {
    if (event.type === 'observed') observedByAttempt.set(event.attemptId, event)
    else if (event.type === 'attempt-lost') lostByAttempt.set(event.attemptId, event)
    else if (event.type === 'effect-observed') effectObservedByOp.set(event.operationId, event)
  }

  const timeline: TraceEntry[] = []
  let outcome: Extract<TraceEntry, { kind: 'terminal' }> | undefined

  for (const event of record.events) {
    if (event.type === 'dispatched') {
      if (event.executor !== 'worker') continue
      const observed = observedByAttempt.get(event.attemptId)
      const lost = lostByAttempt.get(event.attemptId)
      const endedAt = observed?.at ?? lost?.at
      const startMs = Date.parse(event.at)
      const endMs = endedAt ? Date.parse(endedAt) : Number.NaN
      const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : undefined
      const model = observed?.worker?.servedModels?.length ? observed.worker.servedModels.join(', ') : observed?.worker?.model
      const log = observed?.log ? await readAttemptLog(observed.log, store) : undefined
      timeline.push({
        kind: 'attempt',
        stepId: event.stepId,
        attemptId: event.attemptId,
        account: observed?.worker?.ref ?? event.selected,
        ...(model ? { model } : {}),
        startedAt: event.at,
        ...(endedAt ? { endedAt } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        status: observed ? observed.status : lost ? 'lost' : 'running',
        ...(observed?.reason ? { reason: observed.reason } : lost?.reason ? { reason: lost.reason } : {}),
        ...(observed ? { usage: observed.usage } : {}),
        ...(Object.keys(event.inputs).length ? { inputs: event.inputs } : {}),
        ...(observed && Object.keys(observed.outputs).length ? { outputs: observed.outputs } : {}),
        ...(log ? { log } : {}),
      })
    } else if (event.type === 'verified') {
      timeline.push({
        kind: 'verdict',
        stepId: event.stepId,
        attemptId: event.attemptId,
        at: event.at,
        verdict: event.verdict,
        reason: event.reason,
        subject: event.subject,
        ...(event.verdictId ? { verdictId: event.verdictId } : {}),
        ...(event.verifier ? { verifier: event.verifier } : {}),
        ...(event.rerunOf ? { rerunOf: event.rerunOf } : {}),
        failedChecks: readFailedChecks(event, store),
      })
    } else if (event.type === 'reopened') {
      timeline.push({
        kind: 'reopened',
        stepId: event.stepId,
        at: event.at,
        reason: event.reason,
        automatic: Boolean(event.automatic),
        ...(event.caller ? { caller: { type: event.caller.type, operatorId: event.caller.operatorId } } : {}),
        ...(event.previous ? { previous: event.previous } : {}),
        ...(event.failure ? { failure: event.failure } : {}),
        ...(event.failedEffect ? { failedEffect: event.failedEffect } : {}),
        ...(event.base ? { base: event.base } : {}),
        ...(event.worker ? { worker: event.worker } : {}),
        ...(event.reset ? { reset: event.reset } : {}),
      })
    } else if (event.type === 'effect-intended') {
      const obs = effectObservedByOp.get(event.operationId)
      if (obs) pairedOps.add(event.operationId)
      timeline.push({
        kind: 'effect',
        stepId: event.stepId,
        operationId: event.operationId,
        capability: event.capability,
        subject: event.subject,
        provider: event.provider,
        intendedAt: event.at,
        ...(obs ? { observedAt: obs.at } : {}),
        state: obs ? obs.state : 'intended',
        ...(obs?.reason ? { reason: obs.reason } : {}),
        ...(obs?.detail ? { detail: obs.detail } : {}),
        ...(obs?.rejected ? { rejected: obs.rejected } : {}),
        ...(obs?.held ? { held: obs.held } : {}),
      })
    } else if (event.type === 'effect-observed' && !pairedOps.has(event.operationId)) {
      timeline.push({
        kind: 'effect',
        stepId: event.stepId,
        operationId: event.operationId,
        observedAt: event.at,
        state: event.state,
        reason: event.reason,
        ...(event.detail ? { detail: event.detail } : {}),
        ...(event.rejected ? { rejected: event.rejected } : {}),
        ...(event.held ? { held: event.held } : {}),
      })
    } else if (event.type === 'decided') {
      timeline.push({
        kind: 'decided',
        stepId: event.stepId,
        at: event.at,
        decision: event.decision,
        reason: event.reason,
        caller: { type: event.caller.type, operatorId: event.caller.operatorId },
      })
    } else if (event.type === 'skipped') {
      timeline.push({ kind: 'skipped', stepId: event.stepId, at: event.at, reason: event.reason })
    } else if (event.type === 'waiting') {
      timeline.push({ kind: 'waiting', stepId: event.stepId, at: event.at, cause: event.cause, ...(event.resetsAt ? { resetsAt: event.resetsAt } : {}) })
    } else if (event.type === 'terminal') {
      outcome = {
        kind: 'terminal',
        at: event.at,
        outcome: event.outcome,
        reason: event.reason,
        results: event.results,
        ...(event.result ? { result: event.result } : {}),
        ...(event.awaiting ? { awaiting: event.awaiting } : {}),
        ...(event.hold ? { hold: event.hold } : {}),
      }
      timeline.push(outcome)
    }
  }

  return {
    id: record.id,
    status: record.state.status,
    specId: record.state.specId,
    ...(admitted?.item ? { item: admitted.item } : {}),
    admittedAt: first.at,
    timeline,
    ...(outcome ? { outcome } : {}),
  }
}
