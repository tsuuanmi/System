/** A session's real `system mcp` outlives two install updates and Host upgrades. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
// The SDK belongs to the app workspace, not to the smoke-test root.
import { Client } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../packages/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import { codeVersionAt } from '../packages/host/src/index.ts'
import { repo, systemCli } from '../test-support/cli.ts'

test('a running system mcp calls tools through the current release after two real Host upgrades', { timeout: 240_000 }, async (t) => {
  const base = mkdtempSync('/tmp/sm-update-')
  const home = join(base, 'home')
  const current = join(base, 'current')
  const cli = systemCli('mcp-update', { HOME: home, SYSTEM_OPERATOR_ID: 'tester', SYSTEM_NO_SERVICE: '1' }, join(home, '.dsh'), join(current, 'bin', 'system'))
  // Let bin/system infer SYSTEM_CODE from the install, regardless of the test runner's environment.
  delete cli.env.SYSTEM_CODE
  const client = new Client({ name: 'update-smoke', version: '0' })
  const move = (n: number) => {
    symlinkSync(`releases/r${n}`, join(base, 'current.tmp'))
    renameSync(join(base, 'current.tmp'), current)
  }
  try {
    mkdirSync(join(base, 'releases'), { recursive: true })
    for (const n of [1, 2, 3]) {
      const release = join(base, 'releases', `r${n}`)
      mkdirSync(release)
      // Preserve pnpm's relative workspace links inside each independent release.
      execFileSync('cp', ['-a', '--reflink=auto', ...['bin', 'packages', 'node_modules', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'patches', 'workflows'].map((name) => join(repo, name)), release], { timeout: 60_000 })
      if (n > 1) {
        const file = join(release, 'packages', 'app', 'lib', 'client.js')
        const original = readFileSync(file, 'utf8')
        rmSync(file)
        writeFileSync(file, `${original}\n// r${n}\n`)
      }
    }
    const versions = [1, 2, 3].map((n) => codeVersionAt(join(base, 'releases', `r${n}`)))
    assert.equal(new Set(versions).size, 3, 'the install contains three distinct code versions')
    move(1)
    const init = cli.run(['init'])
    assert.equal(init.status, 0, init.stderr)
    let host = await cli.start()
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(current, 'bin', 'system'), 'mcp'], env: cli.env as Record<string, string> }))
    for (const n of [1, 2, 3]) {
      if (n > 1) {
        move(n)
        // Like update.mjs: switch the link, wait for the old Host to drain, then start current.
        assert.deepEqual(await host.exited, { code: 75, signal: null }, host.stderr())
        // A resource request consumes the cached connection's EOF. The next tool
        // call must recover with current's client, without a version refusal.
        await assert.rejects(client.listResources(), /the Host closed the connection/)
        host = await cli.start()
      }
      const result = await client.callTool({ name: 'work.list', arguments: {} })
      const content = result.content as { type: string; text: string }[]
      const text = content[0]!.text
      assert.doesNotMatch(text, /client is older/, `release r${n}: ${text}`)
      assert.notEqual(result.isError, true, `release r${n}: ${text}`)
      assert.deepEqual(JSON.parse(text), [])
      t.diagnostic(`release r${n}: work.list succeeded through the same MCP session`)
    }
  } finally {
    await client.close()
    await cli.stop()
    rmSync(base, { recursive: true, force: true })
  }
})
