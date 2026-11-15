// Lint fixture (Item fl-10, Escaped defect 4's exact shape): the promise is
// returned from inside try of an async function, so finally runs before it settles. eslint.config.js
// ignores this file; lint.test.ts lints it with --no-ignore and expects the failure.
const changedTests = (): Promise<string[]> => Promise.resolve([])

export async function run(done: () => void): Promise<number> {
  try {
    return changedTests().then((tests) => tests.length)
  } finally {
    done()
  }
}
