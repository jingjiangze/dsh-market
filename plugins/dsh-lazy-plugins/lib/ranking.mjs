/**
 * Pure ranking helpers: term extraction, bilingual bridging, duplicate collapsing and the
 * name-family test. No ctx, no settings, no I/O — which is why they live outside index.js.
 * Weights that depend on config (BRIDGE_WEIGHT) stay with the caller.
 */
// Several index rows can point at one real package (`dsh-voice-7`, `dsh-voice-13` both mean
// `dsh-voice`), so results are collapsed by install target and the survivors are ranked by
// whether a registry actually serves them.
export const collapse = (rows) => {
  const byTarget = new Map()
  for (const row of rows) {
    const key = String(row.installAs ?? row.name).toLowerCase()
    const seen = byTarget.get(key)
    if (!seen) {
      byTarget.set(key, row)
      continue
    }
    seen.variants = (seen.variants ?? 1) + 1
    // Prefer a row that is known installable, then one that carries a description.
    const better = (row.installable !== false && seen.installable === false)
      || (Boolean(row.description) && !seen.description)
    if (better) {
      row.variants = seen.variants
      byTarget.set(key, row)
    }
  }
  return [...byTarget.values()]
}

// Two rows are the same family when their name/title share a non-generic core token
// (`dsh-voice` vs `@x/dsh-voice`, `dsh-todo-list` vs `dsh-todo-extract`). Measured: this
// is safer than grouping by metadata.category, which is itself being reworked upstream.
export const GENERIC_NAME_TOKENS = new Set(['dsh', 'plugin', 'plugins', 'tool', 'tools', 'kit', 'panel', 'pro', 'plus', 'lite', 'ai', 'app', 'ui', 'web', 'client', 'core', 'x'])

export const familyTokensOf = (row) => {
  const out = new Set()
  const raw = `${row?.name ?? ''} ${typeof row?.title === 'string' ? row.title : ''}`.toLowerCase()
  const cleaned = raw.replace(/@[a-z0-9._~-]+\//g, ' ')
  for (const token of cleaned.split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (token.length >= 3 && !GENERIC_NAME_TOKENS.has(token)) out.add(token)
  }
  return out
}

export const sameFamily = (a, b) => {
  if (!a || !b) return false
  const left = familyTokensOf(a)
  for (const token of familyTokensOf(b)) if (left.has(token)) return true
  return false
}

export const SYNONYM_GROUPS = [
  ['语音', 'voice', 'tts', 'speech', '朗读'],
  ['待办', 'todo', 'reminder'],
  ['记忆', 'memory'],
  ['搜索', 'search', 'find'],
  ['文档', 'pdf', 'document', 'docx'],
  ['图片', 'image', 'vision', 'photo'],
  ['通知', 'notify', 'notification', 'alert'],
  ['终端', 'terminal', 'shell', 'bash'],
  ['定时', 'schedule', 'cron', 'timer'],
  ['会话', 'session', 'conversation'],
  ['模型', 'model', 'llm'],
  ['主题', 'theme'],
  ['导出', 'export', 'archive'],
  ['监控', 'monitor', 'metric'],
  ['数据库', 'database', 'sql', 'mysql', 'postgres'],
]

// Expand a term set with the partners of any capability word it contains.
// Returns the natural terms plus the bridged ones, separately: scoring gives a bridged
// term a lower weight so it can rescue a miss without pushing direct matches out.
export const expandTerms = (terms) => {
  const bridged = new Set()
  for (const term of terms) {
    for (const group of SYNONYM_GROUPS) {
      // Exact match for short terms (a CJK bigram must not pull in a longer group word),
      // containment only when both sides are long enough to be a real inflection.
      const hit = group.some((word) => term === word
        || (term.length >= 3 && word.length >= 3 && (word.includes(term) || term.includes(word))))
      if (!hit) continue
      let added = 0
      for (const word of group) {
        if (word.length < 2 || terms.includes(word) || added >= 3) continue
        bridged.add(word)
        added += 1
      }
    }
  }
  return { list: [...terms, ...bridged], bridged }
}

// A task sentence is not a keyword: split it into terms, keep CJK bigrams (the index is
// mostly Chinese) and score a row by how many terms its name/title/description carry.
export const termsOf = (text) => {
  const value = String(text ?? '').toLowerCase()
  const terms = new Set()
  for (const word of value.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean)) {
    // Long CJK runs are covered by the bigrams below; keeping them only adds noise.
    const cjkOnly = /^[一-鿿]+$/.test(word);
    if (cjkOnly ? word.length <= 4 : word.length >= 2) terms.add(word)
  }
  const cjk = value.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i + 1 < cjk.length; i += 1) terms.add(cjk.slice(i, i + 2))
  return [...terms].slice(0, 24)
}

