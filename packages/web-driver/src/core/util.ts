// Ported from System 1 (tsuuanmi/system @ f199a277): packages/libs/src/util.ts (`sleep` only). Changes: packages/web-driver/README.md.
/** Wait `ms`; when `signal` aborts first, reject with its reason (at once if it already has). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const stop = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }, ms)
    signal?.addEventListener('abort', stop, { once: true })
  })
}
