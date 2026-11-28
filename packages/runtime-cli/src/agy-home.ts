/** One agy sign-in is one agyHome: its token is refreshed by whichever `agy` runs, and two refreshes of one OAuth token at once logged both sign-ins out (agyconc-1). */
const tails = new Map<string, Promise<unknown>>()

/** Run `fn` when no other run holds `home`, in order; the home is released when `fn` settles. */
export async function exclusiveHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const before = tails.get(home) ?? Promise.resolve()
  const run = before.then(fn, fn)
  const tail = run.catch(() => {}).then(() => { if (tails.get(home) === tail) tails.delete(home) })
  tails.set(home, tail)
  return run
}
