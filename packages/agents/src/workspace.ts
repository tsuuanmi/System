/**
 * One attempt's workspace (ADR-0004 decision 6): a directory holding a
 * throwaway `home/`, read-only inputs in `in/`, an `out/` directory for
 * outputs, and `work/`: a detached git worktree of the exact input commit, or
 * an empty directory when no input names a commit.
 *
 * Output capture, the same rule for every domain: in a git workspace the
 * step's first output slot is the working tree, captured as one commit on the
 * base (`git-tree@1`, pinned); every other slot, and every slot when there is
 * no git workspace, is the file `out/<slot>` (`file@1`). The adapter captures;
 * the agent's claim of what it produced is never used.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Artifacts, Envelope } from '@system/artifacts'
import { GIT_TREE_KIND, TASK_KIND, addWorktree, captureTree, pin, removeWorktree, type GitTreeContent, type Task, type WorkerRequest } from '@system/work'

export interface Workspace {
  root: string
  home: string
  inputs: string
  outputs: string
  work: string
  base?: GitTreeContent
  instructions?: string
  /** Name -> where the agent finds it, for the prompt. */
  listed: { name: string; where: string }[]
}

const MAX_INPUT_BYTES = 16 * 1024 * 1024

function envelopeOf(artifacts: Artifacts, id: string): Envelope {
  const read = artifacts.get(id)
  if (read.state !== 'stored') throw new Error(`input ${id} is not stored`)
  return read.envelope
}

/** Lay out the attempt directory and materialize its inputs. */
export async function prepare(artifacts: Artifacts, request: WorkerRequest, root: string): Promise<Workspace> {
  rmSync(root, { recursive: true, force: true })
  const ws: Workspace = { root, home: join(root, 'home'), inputs: join(root, 'in'), outputs: join(root, 'out'), work: join(root, 'work'), listed: [] }
  for (const dir of [ws.home, ws.inputs, ws.outputs]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  // `previous` (a takeover's partial output) wins as the starting tree; then inputs in name order.
  const names = Object.keys(request.inputs).sort((a, b) => (a === 'previous' ? -1 : b === 'previous' ? 1 : a < b ? -1 : 1))
  for (const name of names) {
    const envelope = envelopeOf(artifacts, request.inputs[name]!)
    if (envelope.kind === GIT_TREE_KIND.kind) {
      if (!ws.base) ws.base = envelope.content as GitTreeContent
      ws.listed.push({ name, where: `the working directory starts from commit ${(envelope.content as GitTreeContent).commit}` })
    } else if (envelope.kind === TASK_KIND.kind) {
      const task = envelope.content as Task
      ws.instructions = task.instructions
      if (task.base && !ws.base) ws.base = envelopeOf(artifacts, task.base).content as GitTreeContent
      ws.listed.push({ name, where: 'the instructions above' })
    } else if (envelope.blob) {
      if (envelope.blob.bytes > MAX_INPUT_BYTES) throw new Error(`input ${name} is ${envelope.blob.bytes} bytes; at most ${MAX_INPUT_BYTES}`)
      const path = join(ws.inputs, name)
      writeFileSync(path, await artifacts.readBytes(envelope.id), { mode: 0o400 })
      ws.listed.push({ name, where: path })
    } else {
      const path = join(ws.inputs, `${name}.json`)
      writeFileSync(path, JSON.stringify(envelope.content, null, 2), { mode: 0o400 })
      ws.listed.push({ name, where: path })
    }
  }
  if (ws.base) await addWorktree(ws.base.repository, ws.work, ws.base.commit)
  else mkdirSync(ws.work, { mode: 0o700 })
  return ws
}

/** The slot captured from the working tree, if any. */
export function treeSlot(ws: Workspace, outputs: readonly string[]): string | undefined {
  return ws.base ? outputs[0] : undefined
}

export function prompt(ws: Workspace, request: WorkerRequest): string {
  const tree = treeSlot(ws, request.outputs)
  const files = request.outputs.filter((slot) => slot !== tree)
  return [
    'You are a Worker for System, a work control plane. Complete this one step, then stop.',
    '',
    `Step: ${request.stepId}`,
    '',
    'Instructions:',
    ws.instructions ?? '(no written instructions; use the inputs)',
    '',
    ...(request.instructions ? ['Instructions for this step:', request.instructions, ''] : []),
    ...(ws.listed.length ? ['Inputs (read-only):', ...ws.listed.map((i) => `- ${i.name}: ${i.where}`), ''] : []),
    `Your working directory is ${ws.work}.`,
    ...(tree ? [
      `It is a git checkout of commit ${ws.base!.commit}. Make your changes there and leave them in the working tree:`,
      `they are captured as the output "${tree}". Do not commit, push, or open pull requests.`,
    ] : []),
    ...(files.length ? [
      `Write each of these outputs as a file in ${ws.outputs}:`,
      ...files.map((slot) => `- ${slot} (the file ${join(ws.outputs, slot)})`),
    ] : []),
    '',
    'Do not read or change anything outside these directories unless the instructions require it.',
  ].join('\n')
}

export interface Captured {
  outputs: Record<string, string>
  missing: string[]
}

/** Capture what the attempt produced; partial captures keep whatever exists. */
export async function capture(artifacts: Artifacts, ws: Workspace, request: WorkerRequest, producer: string): Promise<Captured> {
  const tree = treeSlot(ws, request.outputs)
  const outputs: Record<string, string> = {}
  const missing: string[] = []
  const common = {
    inputs: Object.values(request.inputs), classification: 'local-private' as const,
    producer: { type: 'worker' as const, ref: producer }, workId: request.workId, attemptId: request.attemptId,
  }
  for (const slot of request.outputs) {
    if (slot === tree) {
      const captured = await captureTree(ws.base!.repository, ws.work, ws.base!.commit, `system: ${request.stepId} output ${slot}\n\nWork: ${request.workId}\nAttempt: ${request.attemptId}`)
      await pin(captured.repository, captured.commit)
      outputs[slot] = (await artifacts.put({ ...GIT_TREE_KIND, ...common, content: captured, subject: { type: 'git-commit', ref: captured.commit } })).id
      continue
    }
    const path = join(ws.outputs, slot)
    if (!existsSync(path) || !statSync(path).isFile()) {
      missing.push(slot)
      continue
    }
    const data = readFileSync(path)
    outputs[slot] = (await artifacts.putBytes({ kind: 'file', schemaVersion: 1, ...common, data, mediaType: mediaTypeOf(data) })).id
  }
  return { outputs, missing }
}

function mediaTypeOf(data: Buffer): string {
  try {
    JSON.parse(data.toString('utf8'))
    return 'application/json'
  } catch {
    return 'text/plain'
  }
}

/** Remove the worktree registration and the attempt directory. */
export async function cleanup(ws: Workspace): Promise<void> {
  if (ws.base) await removeWorktree(ws.base.repository, ws.work)
  rmSync(ws.root, { recursive: true, force: true })
}
