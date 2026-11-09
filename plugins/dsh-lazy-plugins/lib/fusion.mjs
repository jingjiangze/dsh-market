/**
 * Reciprocal-rank fusion for two rankers.
 *
 * Why ranks and not scores: BM25 scores are unbounded and encoder cosines live in [-1, 1], so
 * any weighted sum needs a per-catalogue calibration that silently rots. Ranks need none.
 *
 * Measured on 2,000 judged needs against the live catalogue (13,789 rows, full descriptions):
 *   bm25      R@1 11.05%  R@5 19.95%  R@20 30.80%
 *   embedding R@1  9.60%  R@5 19.50%  R@20 30.25%
 *   fused     R@1 13.35%  R@5 23.30%  R@20 34.20%
 * The two rankers fail on different rows, which is the whole reason fusion pays here.
 */

/** The fusion constant from Cormack et al.: 60 is flat across corpora, so nothing to tune. */
export const RRF_K = 60

/**
 * Fuse ranked id lists into one order. `lists` are ordered best-first; ids missing from a list
 * simply contribute nothing. Returns `[{ id, score }]`, best first.
 */
export const rrfFuse = (lists, options = {}) => {
  const k = Number(options.k) > 0 ? Number(options.k) : RRF_K
  const scores = new Map()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (let rank = 0; rank < list.length; rank += 1) {
      const id = list[rank]
      if (id === undefined || id === null) continue
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1))
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([id, score]) => ({ id, score }))
}
