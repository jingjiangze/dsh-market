/**
 * BM25 over the plugin catalogue — the retrieval half the model calls, with no dependency and no
 * hand-written ranking weights. The current `suggest` scores by "does the row contain this term,
 * weighted by inverse document frequency", which is a boolean-ish model: three mentions of a word
 * score the same as one, and a long description is not penalised. BM25 fixes both (term-frequency
 * saturation + length normalisation) and is what every search stack uses before a ranker.
 *
 * Terms: ASCII words of length >= 2 and CJK bigrams (the catalogue is mostly Chinese prose).
 * Why bigrams rather than a segmenter: no dictionary to ship, no service to call, and the
 * catalogue's titles are short enough that bigram collisions ("发票" vs "发展票价") are rare in
 * practice — measured on the recall set below.
 */

import { CAPABILITY_LEXICON, CJK_STOP_CHARS, isFillerTerm } from './ranking.mjs'

const K1 = 1.2
const B = 0.75

const isCjk = (ch) => ch >= '\u4e00' && ch <= '\u9fff'

export const tokenize = (text) => {
  const value = String(text ?? '').toLowerCase()
  const tokens = []
  for (const word of value.split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!word) continue
    if (/^[a-z0-9]+$/.test(word)) {
      if (word.length >= 2) tokens.push(word)
      continue
    }
    // Mixed run: take the ASCII part as a token and the CJK run as bigrams.
    const ascii = word.replace(/[^a-z0-9]/g, '')
    if (ascii.length >= 2) tokens.push(ascii)
    const cjk = [...word].filter(isCjk).join('')
    for (let i = 0; i + 1 < cjk.length; i += 1) {
      const bigram = cjk.slice(i, i + 2)
      // Same reason as the lexical path: a bigram made of function characters (的/一/能/个)
      // matches prose, not capability. Measured: without this, "一张"/"成一" decided a
      // 报销单据 query and pulled screen-recording plugins to the top.
      // Drop a bigram that merely straddles two words (手上|有一|的报|一张) — same rule as
      // the lexical path: any function character disqualifies it unless it is a known term.
      if (isFillerTerm(bigram)) continue
      if (!CAPABILITY_LEXICON.has(bigram) && [...bigram].some((ch) => CJK_STOP_CHARS.has(ch))) continue
      tokens.push(bigram)
    }
  }
  return tokens
}

/**
 * Build the index. `docs` is `[{ id, text }]`; the caller decides what text means (name + title +
 * description + tags). Returns a plain object so it can be JSON-serialised as a cache.
 */
export const buildIndex = (docs) => {
  const postings = new Map() // term -> [[docIdx, tf], ...]
  const lengths = new Array(docs.length)
  let totalLength = 0
  for (let i = 0; i < docs.length; i += 1) {
    const counts = new Map()
    const tokens = tokenize(docs[i].text)
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
    lengths[i] = tokens.length
    totalLength += tokens.length
    for (const [term, tf] of counts) {
      const list = postings.get(term)
      if (list) list.push([i, tf])
      else postings.set(term, [[i, tf]])
    }
  }
  return {
    docs: docs.map((doc) => ({ id: doc.id, length: 0 })).map((doc, i) => ({ id: doc.id, length: lengths[i] })),
    postings: [...postings.entries()],
    avgLength: docs.length ? totalLength / docs.length : 0,
    size: docs.length,
  }
}

/**
 * Score one query. Returns `[{ id, score, terms }]` sorted by score, `terms` being the per-term
 * contribution so a caller (or the model) can see *why* a row ranked.
 */
export const search = (index, query, options = {}) => {
  const limit = Math.max(1, Number(options.limit) || 10)
  const terms = [...new Set(tokenize(query))]
  if (!terms.length || !index?.size) return { hits: [], terms: 0 }

  const scores = new Map()
  const why = new Map()
  const N = index.size
  const avg = index.avgLength || 1
  const postings = new Map(index.postings)

  for (const term of terms) {
    const list = postings.get(term)
    if (!list || !list.length) continue
    const df = list.length
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    for (const [docIdx, tf] of list) {
      const doc = index.docs[docIdx]
      if (!doc) continue
      const norm = tf + K1 * (1 - B + B * (doc.length / avg))
      const contribution = idf * ((tf * (K1 + 1)) / (norm || 1))
      scores.set(doc.id, (scores.get(doc.id) ?? 0) + contribution)
      const bag = why.get(doc.id) ?? []
      if (bag.length < 8) bag.push({ term, w: Math.round(contribution * 100) / 100 })
      why.set(doc.id, bag)
    }
  }

  const hits = [...scores.entries()]
    .map(([id, score]) => ({ id, score: Math.round(score * 100) / 100, terms: why.get(id) ?? [] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return { hits, terms: terms.length }
}

export const BM25_PARAMS = { K1, B }
