// Serves the fake ChatGPT site (fake-chatgpt.ts) on a free local port, prints its origin, and runs until SIGTERM.
// For tests that block their own event loop (the CLI runner) and so cannot host it. argv[2]: the fake's options as JSON.
import { FakeChatGpt, type FakeOptions } from './fake-chatgpt.ts'

const options = JSON.parse(process.argv[2] ?? '{}') as FakeOptions
const fake = new FakeChatGpt({ thinkMs: 100, codeWidget: true, ...options })
console.log(await fake.start())
process.on('SIGTERM', () => void fake.stop().then(() => process.exit(0)))
