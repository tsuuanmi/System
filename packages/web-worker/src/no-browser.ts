/**
 * WW6l: `SYSTEM_NO_BROWSER=1` (set by the `test` and `smoke` scripts, never by `test:web`) makes every launch of Chrome
 * or Xvfb by System code throw at once, so the default suites cannot start a browser by mistake.
 */
export function refuseBrowser(): void {
  if (process.env.SYSTEM_NO_BROWSER === '1') throw new Error('a browser launch was refused: SYSTEM_NO_BROWSER is set (this test belongs in test:web)')
}
