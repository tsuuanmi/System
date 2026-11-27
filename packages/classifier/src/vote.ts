/** The vote of a Classifier's samples (cls-1): the label distribution is each label's share, the confidence the winner's share. */
import { UNKNOWN } from './schema.ts'

interface Voted {
  label: string
  confidence: number
  distribution: Record<string, number>
  disagreement: boolean
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * `answers` are the labels the model gave, `undefined` for a reply of no shape. One that is not among `labels` is a vote for
 * `unknown`. A tie, or a winner under two thirds of the votes, is `unknown`.
 */
export function vote(answers: readonly (string | undefined)[], labels: readonly string[]): Voted {
  const counts = new Map<string, number>()
  for (const answer of answers) {
    const counted = answer !== undefined && labels.includes(answer) ? answer : UNKNOWN
    counts.set(counted, (counts.get(counted) ?? 0) + 1)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const [winner, top] = ranked[0] ?? [UNKNOWN, 0]
  const tied = ranked[1]?.[1] === top
  // top / n >= 2/3, without a float.
  const decisive = !tied && top * 3 >= answers.length * 2
  return {
    label: decisive ? winner : UNKNOWN,
    confidence: round2(top / answers.length),
    distribution: Object.fromEntries(ranked.map(([l, n]) => [l, round2(n / answers.length)])),
    disagreement: new Set(answers.map((a) => a ?? '')).size > 1,
  }
}
