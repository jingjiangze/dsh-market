// Publishing gate for `metadata.category`.
//
// On 2026-11-07 the published `index.zh.json` carried 14 categories (`work`, `data`,
// `connect`, …) that the taxonomy had already replaced with 31 leaf ids: lang-index
// copies the category out of `dist/index.json` and never re-derives it, so a stale
// build published a document whose categories no leaf in taxonomy.mjs could render —
// and nothing failed. This gate makes that build fail instead.
//
// Refuses (throws) when a document declares a category the taxonomy does not define.
// `other` is a real leaf, so it always passes.
import { CATEGORIES } from './taxonomy.mjs'

const SAMPLES = 8

// Every distinct category in `plugins` that is not a declared leaf, most used first.
export function unknownCategories(plugins) {
  const declared = new Set(Object.keys(CATEGORIES))
  const counts = new Map()
  for (const plugin of plugins ?? []) {
    const category = plugin?.metadata?.category
    if (declared.has(category)) continue
    const key = category === undefined || category === null || category === '' ? '(missing)' : String(category)
    const row = counts.get(key) ?? { category: key, count: 0, samples: [] }
    row.count++
    if (row.samples.length < SAMPLES) row.samples.push(String(plugin?.name ?? '?'))
    counts.set(key, row)
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)
}

// Throws with an actionable report. `label` names the document being written, so the
// error says which build step produced the bad data.
export function assertKnownCategories(plugins, label = 'index') {
  const unknown = unknownCategories(plugins)
  if (!unknown.length) return
  const lines = unknown.map((row) =>
    `  ${row.category}  ${String(row.count).padStart(6)}  e.g. ${row.samples.slice(0, 3).join(', ')}`)
  throw new Error([
    `${label}: refusing to publish ${unknown.reduce((n, row) => n + row.count, 0)} entries whose ` +
    `metadata.category is not a taxonomy leaf (${Object.keys(CATEGORIES).length} declared):`,
    ...lines,
    '',
    'These ids come from a stale dist/index.json: crawler/lang-index.mjs copies the',
    'category as-is, so an old build republishes old buckets. Re-run crawler/crawl.mjs',
    '(it re-derives every category via taxonomy.categoryFor) and publish again.',
  ].join('\n'))
}
