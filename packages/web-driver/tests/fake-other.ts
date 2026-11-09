/**
 * A deliberately hostile second Site (WW2-ii), invented, unlike chatgpt.com in every way the Procedures could lean on it:
 * - no temporary chat and no mode switch (the map has no `site.temporaryChat` and no `modes`);
 * - a plain `textarea` composer and a submit button with no name the map can use but its class;
 * - no Stop button: a status element says "Generating…" while it works and "Done" after, and it stays "Done" for a
 *   moment after the next send (`statusLagMs`), so a stale marker cannot be taken for the new answer;
 * - the site's own error is text inside the answer's container, with the status already "Done";
 * - a code block's label is its own element above the `pre`, not part of it;
 * - a pasted text stays text, unless it is longer than `attachOver`: then it becomes a file chip (a list item whose own text is
 *   the start of the pasted text, not an aria-label) after a moment, shown in the list as "Reading file…" meanwhile;
 * - every send is a `POST /api/send` the fake counts, and the page shows the user's turn only after it answers.
 * Answers are Markdown-ish: ``` fences become labelled blocks, `[text](url)` a link, each other line a paragraph.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'

export interface OtherOptions {
  /** Signed in (default true); false: the page asks to sign in and has no composer. */
  signedIn?: boolean
  /** The answer, or a function of the prompt (default "OK"). */
  answer?: string | ((prompt: string) => string)
  /** Delay before the answer starts, in ms (default 200). */
  thinkMs?: number
  /** The status stays "Done" this long after a send (default 150). */
  statusLagMs?: number
  /** The site gives up on the answer: its text is replaced by "Something went wrong" inside the answer, the status "Done". */
  failAnswer?: boolean
  /** The send reaches the site and the composer clears, but no turn ever shows (the acknowledgement is lost). */
  dropSend?: boolean
  /** Every page is a challenge. */
  challenge?: boolean
  /** Code blocks have no label element. */
  plainBlocks?: boolean
  /** A paste over this many characters becomes a file chip (0: never; default 0). */
  attachOver?: number
}

export class FakeOther {
  /** Prompts the site received, in order. */
  readonly sent: string[] = []
  private server: Server | undefined
  private readonly options: Required<OtherOptions>
  origin = ''

  constructor(options: OtherOptions = {}) {
    this.options = { signedIn: true, answer: 'OK', thinkMs: 200, statusLagMs: 150, failAnswer: false, dropSend: false, challenge: false, attachOver: 0, plainBlocks: false, ...options }
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.origin = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`
    return this.origin
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve())
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin)
    if (url.pathname === '/api/send' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      const prompt = (JSON.parse(body) as { prompt: string }).prompt
      this.sent.push(prompt)
      const answer = typeof this.options.answer === 'function' ? this.options.answer(prompt) : this.options.answer
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answer }))
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(this.page())
  }

  private page(): string {
    const { signedIn, thinkMs, statusLagMs, failAnswer, dropSend, challenge, attachOver, plainBlocks } = this.options
    if (challenge) return '<!doctype html><title>Just a moment</title><main><h1>Checking your browser</h1></main>'
    if (!signedIn) return '<!doctype html><title>Welcome</title><main><h1>Welcome back</h1><a class="signin" href="/login">Sign in to continue</a></main>'
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Other</title>
<style>.lbl{font:12px monospace;color:#555} pre{margin:0 0 8px} #status{min-height:1em}</style></head><body><main>
<section id="log"></section>
<p id="status" role="status"></p>
<form id="composer"><ul id="files"></ul><textarea id="box" rows="3" placeholder="Ask anything"></textarea><button type="submit" class="go">Submit</button></form>
</main><script>
const $ = (id) => document.getElementById(id)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function render(text) {
  const parts = text.split(/\`\`\`([^\\n]*)\\n([\\s\\S]*?)\\n\`\`\`/)
  let html = ''
  for (let i = 0; i < parts.length; i += 3) {
    html += esc(parts[i]).split('\\n').filter((line) => line.trim()).map((line) => '<p>' + line.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>') + '</p>').join('')
    if (i + 2 < parts.length) html += '<div class="blk">' + (${JSON.stringify(plainBlocks)} ? '' : '<div class="lbl">' + esc(parts[i + 1]) + '</div>') + '<pre><code>' + esc(parts[i + 2]) + '</code></pre></div>'
  }
  return html
}
const attached = []
$('box').addEventListener('paste', (event) => {
  const pasted = event.clipboardData.getData('text/plain')
  if (!${attachOver} || pasted.length <= ${attachOver}) return
  event.preventDefault()
  const li = document.createElement('li')
  li.className = 'reading'
  li.textContent = 'Reading file…'
  $('files').append(li)
  setTimeout(() => {
    li.className = 'file'
    li.textContent = pasted.replace(/\\s+/g, ' ').slice(0, 60) + '…'
    attached.push(pasted)
  }, 300)
})
$('composer').addEventListener('submit', async (event) => {
  event.preventDefault()
  const prompt = [$('box').value.trim(), ...attached].filter(Boolean).join('\\n')
  if (!prompt) return
  $('box').value = ''
  attached.length = 0
  $('files').textContent = ''
  const res = await fetch('/api/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt }) })
  const { answer } = await res.json()
  if (${JSON.stringify(dropSend)}) return
  const me = document.createElement('article')
  me.className = 'msg me'
  me.innerHTML = '<p></p>'
  me.querySelector('p').textContent = prompt
  $('log').append(me)
  await wait(${statusLagMs})
  $('status').textContent = 'Generating…'
  await wait(${thinkMs})
  const bot = document.createElement('article')
  bot.className = 'msg bot'
  bot.innerHTML = '<span class="who">Bot:</span> <div class="body"></div>'
  $('log').append(bot)
  const words = answer.split(/(?<= )/)
  for (let i = 1; i <= words.length; i++) {
    bot.querySelector('.body').textContent = words.slice(0, i).join('')
    await wait(40)
  }
  bot.querySelector('.body').innerHTML = ${JSON.stringify(failAnswer)} ? '<p class="oops">Something went wrong. Please try again.</p>' : render(answer)
  $('status').textContent = 'Done'
})
</script></body></html>`
  }
}
