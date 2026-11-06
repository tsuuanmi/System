/**
 * The commit lane (PROP-0004 C2): one ordered path for everything that decides
 * a change to a Work. A section runs only after the one before it has ended, so
 * two decisions never interleave; a section that throws does not block the next.
 * Sections must not enter the lane again: they would wait for themselves.
 */
export type Lane = <T>(section: () => Promise<T>) => Promise<T>

/** A lane that runs each section at once: one process driving one Work, as before the Host. */
export const noLane: Lane = (section) => section()

/** A new lane: a promise chain. */
export function commitLane(): Lane {
  let tail: Promise<unknown> = Promise.resolve()
  return (section) => {
    const result = tail.then(section)
    tail = result.catch(() => undefined)
    return result
  }
}
