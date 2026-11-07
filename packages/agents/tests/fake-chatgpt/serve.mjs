// Serves the fake ChatGPT page on a free local port and prints the port; for tests that block their own event loop.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
createServer((req, res) => {
  const file = req.url?.startsWith('/chat.js') ? 'chat.js' : 'index.html'
  res.setHeader('content-type', file === 'chat.js' ? 'text/javascript' : 'text/html')
  res.end(readFileSync(join(dir, file)))
}).listen(0, '127.0.0.1', function () { console.log(this.address().port) })
