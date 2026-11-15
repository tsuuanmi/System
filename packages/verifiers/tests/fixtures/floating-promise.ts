// Lint fixture (Item fl-10): the promise is dropped inside try/finally, so the
// cleanup runs before the work finishes. eslint.config.js ignores this file;
// lint.test.ts lints it with --no-ignore and expects the failure.
async function work(): Promise<void> {}

export async function run(cleanup: () => void): Promise<void> {
  try {
    work()
  } finally {
    cleanup()
  }
}
