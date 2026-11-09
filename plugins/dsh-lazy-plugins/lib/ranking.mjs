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

// Characters that carry no capability meaning. A bigram built only from these is filler:
// it matches prose ("把这个…"), never a capability.
export const CJK_STOP_CHARS = new Set('我你他她它们的了着过把被让给和与及或是在有没不很太更最都也就要会能可请帮想要个这那些么什怎哪谁如何为对从到向于其之而且但假如若虽然因此所以以为所将并且来去说做用上下中')

export const CJK_GENERIC_VERBS = new Set([
  '整理', '转成', '转换', '成文', '理成', '生成', '制作', '处理', '检查', '查看', '显示',
  '支持', '提供', '实现', '完成', '创建', '添加', '删除', '修改', '更新', '使用', '管理',
  '操作', '记录', '保存', '打开', '关闭', '发送', '接收', '导入', '合并', '拆分', '批量',
  '一键', '自动', '帮我', '给我', '帮我做', '弄成', '搞成', '做个', '做一个', '汇总', '统计', '展示', '显示出来',
])

export const CJK_STOP_BIGRAMS = new Set(['帮我', '我把', '把这', '这个', '那个', '个月', '月的', '一下', '一些', '一个', '可以', '能够', '需要', '我们', '你们', '他们', '什么', '怎么', '如何', '如果', '因为', '所以', '但是', '而且', '然后', '现在', '今天', '明天', '昨天', '这个月', '整理一下', '做个', '能看'])

const EN_STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'with', 'my', 'me', 'i', 'we', 'you', 'it', 'this', 'that', 'these', 'those', 'please', 'help', 'need', 'want', 'make', 'do', 'is', 'are', 'be'])

// Capability words that contain a function character and must survive the filter.
export const CAPABILITY_LEXICON = new Set(SYNONYM_GROUPS.flat().map((word) => word.toLowerCase()))

export const isFillerTerm = (term) => {
  const value = String(term ?? '')
  if (!value) return true
  if (/^[\u4e00-\u9fff]+$/.test(value)) {
    if (CJK_STOP_BIGRAMS.has(value)) return true
    const chars = [...value]
    return chars.every((ch) => CJK_STOP_CHARS.has(ch))
  }
  return EN_STOP.has(value)
}

// A task sentence is not a keyword: split it into terms, keep CJK bigrams (the index is
// mostly Chinese) and score a row by how many terms its name/title/description carry.
export const termsOf = (text) => {
  const value = String(text ?? '').toLowerCase()
  const terms = new Set()
  for (const word of value.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean)) {
    // Long CJK runs are covered by the bigrams below; keeping them only adds noise.
    const cjkOnly = /^[一-鿿]+$/.test(word);
    if (/^[0-9]+$/.test(word)) continue
    if (cjkOnly ? word.length <= 4 : word.length >= 3) terms.add(word)
  }
  const cjk = value.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i + 1 < cjk.length; i += 1) {
    const bigram = cjk.slice(i, i + 2)
    if (isFillerTerm(bigram)) continue
    const crossesWordBoundary = [...bigram].some((ch) => CJK_STOP_CHARS.has(ch))
    if (crossesWordBoundary && !CAPABILITY_LEXICON.has(bigram)) continue
    terms.add(bigram)
  }
  // Filler words never reach the scorer, so the cap only ever trims real terms.
  return [...terms]
    .filter((term) => !isFillerTerm(term) && !CJK_GENERIC_VERBS.has(term))
    .slice(0, 24)
}

