/**
 * Fuzzy matching for the Postal session picker.
 *
 * `fuzzyScore` returns Number.NEGATIVE_INFINITY when the query is not a
 * subsequence of the text. The length penalty only affects ranking, so a
 * valid sparse match in a long title is never filtered out.
 */

export type FuzzyOption = { title: string; description?: string }

const WORD_BOUNDARY = /[\s_\-.:\/]/

export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 0
  let qi = 0
  let score = 0
  let last = -2
  let streak = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue
    streak = last === ti - 1 ? streak + 1 : 0
    score += 1 + streak * 2
    if (ti === 0 || WORD_BOUNDARY.test(t[ti - 1])) score += 3
    last = ti
    qi++
  }
  if (qi < q.length) return Number.NEGATIVE_INFINITY
  return score - t.length * 0.01
}

export function fuzzySearch<T extends FuzzyOption>(query: string, options: T[]): T[] {
  if (!query.trim()) return options
  return options
    .map((option) => ({
      option,
      score: Math.max(fuzzyScore(query, option.title), fuzzyScore(query, option.description ?? "")),
    }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.option)
}
