import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildProgram, type ClientHost, type Run } from '../src/cli.ts'

const record = (id: string, status: string, extra: object = {}) => ({ id, events: [], state: { status, ...extra } }) as any

/** Run `system ...args` against a fake Host; returns the exit code, stdout and stderr. */
async function system(args: string[], work: object, confirm: (prompt: string, expected: string) => Promise<string> = async () => 'tan') {
  let out = ''
  let err = ''
  let run: Run | undefined
  const io = { out: (t: string) => { out += t }, err: (t: string) => { err += t }, confirmHuman: confirm } as any
  const program = buildProgram({ work: () => work } as unknown as ClientHost, io, (r) => { run = r })
  program.exitOverride()
  await program.parseAsync(['node', 'system', ...args])
  const code = await run!()
  return { code, out, err }
}

test('task new prints the Task ID alone on stdout, and the base commit on stderr', async () => {
  const result = await system(['task', 'new', '--text', 'x', '--repo', '.'], { newTask: async () => ({ task: 'sha256:task', base: 'sha256:base' }) })
  assert.equal(result.out, 'sha256:task\n')
  assert.match(result.err, /base sha256:base/)
})

for (const verb of ['approve', 'deny'] as const) {
  test(`${verb} several Works asks for one typed confirmation and decides each`, async () => {
    const decided: string[] = []
    const asked: { prompt: string; expected: string }[] = []
    const work = {
      get: async (id: string) => record(id, 'held', { reason: 'awaiting', awaiting: 'publish' }),
      decide: async (id: string, decision: string, who: string) => { decided.push(`${id} ${decision} ${who}`); return record(id, decision === 'approved' ? 'succeeded' : 'failed') },
    }
    const result = await system([verb, 'work:aaaaaaaa1', 'work:bbbbbbbb2', 'work:cccccccc3', '--reason', 'tidy'], work, async (prompt, expected) => { asked.push({ prompt, expected }); return 'tan' })
    assert.equal(asked.length, 1, 'one confirmation for all')
    assert.equal(asked[0]!.expected, `${verb} 3`)
    for (const id of ['work:aaaaaaaa1', 'work:bbbbbbbb2', 'work:cccccccc3']) assert.ok(asked[0]!.prompt.includes(id) || result.out.includes(id), id)
    const decision = verb === 'approve' ? 'approved' : 'denied'
    assert.deepEqual(decided, ['work:aaaaaaaa1', 'work:bbbbbbbb2', 'work:cccccccc3'].map((id) => `${id} ${decision} tan`))
    assert.equal(result.code, verb === 'approve' ? 0 : 1)
  })
}

test('deciding several Works refuses them all, deciding none, when one does not exist', async () => {
  const decided: string[] = []
  const work = {
    get: async (id: string) => (id === 'work:missing' ? undefined : record(id, 'held')),
    decide: async (id: string) => { decided.push(id); return record(id, 'failed') },
  }
  await assert.rejects(system(['deny', 'work:a', 'work:missing', '--reason', 'x'], work), /no Work work:missing/)
  assert.deepEqual(decided, [])
})

test('claim records a claim on an Item of the repository', async () => {
  const seen: unknown[] = []
  const result = await system(['claim', 'df-24', '--repo', '/r', '--force'], { claim: async (...args: unknown[]) => { seen.push(args); return { who: 'tan', at: 'T' } } })
  assert.deepEqual(seen, [['/r', 'df-24', true]])
  assert.match(result.out, /df-24 claimed by tan/)
})
