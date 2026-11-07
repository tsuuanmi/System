// A fake ChatGPT page. Query: scenario=normal|late-copy|early-copy|links|signin|captcha|blank|session|forever,
// slots=a,b (the fenced blocks it answers with), omit=a (leave one out), delay=ms between chunks,
// model=none (show no model label). scenario=remote: a sign-in wall whose "Log in" button (top left) sets the session cookie.
// Every page reports what it saw to POST /event, for tests that watch a real click arrive.
const q = new URLSearchParams(location.search)
const scenario = q.get('scenario') ?? 'normal'
const slots = (q.get('slots') ?? 'report').split(',')
const omit = q.get('omit')
const model = q.get('model')
const delay = Number(q.get('delay') ?? 150)
const turns = document.querySelector('#turns')
const composer = document.querySelector('#prompt-textarea')
const send = document.querySelector('[data-testid="send-button"]')
const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const report = (event) => navigator.sendBeacon('/event', JSON.stringify(event))
report({ type: 'load', ua: navigator.userAgent, scenario })
document.addEventListener('click', (e) => report({ type: 'click', x: e.clientX, y: e.clientY, id: e.target.id || null }))
document.addEventListener('keydown', (e) => report({ type: 'key', key: e.key }))
const signedIn = scenario !== 'signin' && ((scenario !== 'session' && scenario !== 'remote') || document.cookie.includes('session=ok'))

if (scenario === 'blank') {
  document.body.innerHTML = '<p>Something went wrong.</p>'
} else if (scenario === 'captcha') {
  document.title = 'Just a moment...'
  document.body.innerHTML = '<form id="challenge-form"><p>Verify you are human</p><input type="checkbox"></form>'
} else {
  if (model !== 'none') document.body.insertAdjacentHTML('afterbegin', '<button data-testid="model-switcher-dropdown-button">Fake GPT 5</button>')
  if (!signedIn) document.body.insertAdjacentHTML('afterbegin', '<button id="login" data-testid="login-button">Log in</button>')
  if (!signedIn && scenario === 'remote') {
    document.querySelector('#login').addEventListener('click', () => { document.cookie = 'session=ok; max-age=86400; path=/'; location.reload() })
  }
  composer.addEventListener('input', () => { send.disabled = !composer.innerText.trim() })
  send.addEventListener('click', () => { void answer(composer.innerText); composer.textContent = ''; send.disabled = true })
}

function addTurn(role, html) {
  const article = document.createElement('article')
  article.dataset.testid = `conversation-turn-${turns.children.length + 1}`
  article.innerHTML = `<div data-message-author-role="${role}"><div class="markdown">${html}</div></div>`
  turns.append(article)
  return article
}

const copyButton = '<div class="actions"><button data-testid="copy-turn-action-button">Copy</button></div>'

function chunks() {
  const blocks = slots.filter((slot) => slot !== omit).map((slot) => `<pre><div class="lang">${slot}</div><code class="language-${slot}">content of ${slot}\nsecond line</code></pre>`)
  const links = scenario === 'links' ? ['<p>See <a href="https://example.org/a">source A</a> and <a href="https://example.org/b?x=1">B</a>.</p>'] : []
  return ['<p>Here is the <strong>answer</strong>.</p>', ...links, ...blocks]
}

async function answer(prompt) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  addTurn('user', `<p>${escape(prompt)}</p>`)
  const parts = scenario === 'forever' ? [] : chunks()
  const turn = addTurn('assistant', '')
  const body = turn.querySelector('.markdown')
  if (scenario === 'early-copy' || scenario === 'forever') turn.insertAdjacentHTML('beforeend', copyButton)
  if (scenario === 'forever') {
    for (let i = 0; ; i++) { body.insertAdjacentHTML('beforeend', `<p>still thinking ${i}</p>`); await wait(100) }
  }
  for (const part of parts) { await wait(delay); body.insertAdjacentHTML('beforeend', part) }
  if (scenario === 'late-copy') await wait(1500)
  if (scenario !== 'early-copy') turn.insertAdjacentHTML('beforeend', copyButton)
}
