// A fake ChatGPT page for the remote sign-in tests (viewer events, Save): a signed-out page whose "Log in" button
// (top left) sets the session cookie, then the page with a composer the driver reads as signed in.
// Every page reports what it saw to POST /event, for tests that watch a real click arrive. The Runtime's own
// attempts run against the ported site (packages/web-driver/tests/fake-chatgpt.ts).
const report = (event) => navigator.sendBeacon('/event', JSON.stringify(event))
report({ type: 'load', ua: navigator.userAgent, scenario: new URLSearchParams(location.search).get('scenario') })
document.addEventListener('click', (e) => report({ type: 'click', x: e.clientX, y: e.clientY, id: e.target.id || null }))
document.addEventListener('keydown', (e) => report({ type: 'key', key: e.key }))
if (!document.cookie.includes('session=ok')) {
  // The logged-out home: an anonymous composer in a marked form, and a sign-in button.
  document.querySelector('#composer-form').dataset.loggedOut = ''
  document.body.insertAdjacentHTML('afterbegin', '<button id="login" data-testid="login-button">Log in</button>')
  document.querySelector('#login').addEventListener('click', () => { document.cookie = 'session=ok; max-age=86400; path=/'; location.reload() })
}
