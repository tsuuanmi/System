/**
 * Import this in a test that starts a browser binary (even a stand-in for one) but needs no Xvfb: it marks the file as a
 * browser test, so `pnpm test:web` may list it (packages/web-worker/tests/web-check-guard.test.ts). A test that starts no
 * browser belongs in the unit run, not in the web check.
 */
export const startsBrowser = true
