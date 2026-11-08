// Community tags: one small document, so a Chinese-described row can answer an English need.
//
// The catalogue's descriptions are Chinese (99.96% of rows). An on-demand loader that matches
// a need like "text to speech" against "达妮娅（语音朗读）" misses, because the words are not
// there. The community registries carry English tags per package, so this copies only the
// tags of names this catalogue already has, into their own document:
//
//   { format: 'dsh-plugin-tags', schema: 1, generatedAt, count, tags: { '<name>': ['tts', …] } }
//
// Size is bounded by MAX_TAGS per name and by the overlap (measured 2026-11-08: 7,297 of
// 12,455 community rows exist here, ~0.3 MB). It is deliberately NOT part of format 1 or of
// plugin-index.json: a reader that does not want tags must not pay for them.
//
// Only tags are copied. The same registries publish `stars`, `downloads` and `verified`, and
// none of them survives inspection — measured on the 2026-11-07 document: `dsh-our-free-model`
// reports 64,573 stars, `claude-flow` 81,107 stars with 7 downloads, and `verified` is true for
// 93% of rows. Ranking on those numbers would rank noise, so this script ignores them.
//
// Sources are cached in data/community-tags-cache.json and committed, so a re-run inside
// TAGS_TTL_HOURS costs no network; the raw registry is 13 MB.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = [join(root, 'dist', 'index.json'), join(root, 'site', 'index.zh.json')].find((p) => existsSync(p))
if (!INDEX) {
  console.error('plugin-tags: no index found')
  process.exit(1)
}

const CACHE = join(root, 'data', 'community-tags-cache.json')
const OUT = [join(root, 'dist', 'plugin-tags.json'), join(root, 'site', 'plugin-tags.json')]
const TTL_HOURS = Number(process.env.TAGS_TTL_HOURS || 12)
const TIMEOUT_MS = Number(process.env.TAGS_TIMEOUT_MS || 60000)
const MAX_TAGS = Number(process.env.TAGS_MAX || 8)
const SOURCES = [
  'https://raw.githubusercontent.com/losebird/dsh-plugin-market/main/registry/all.json',
  'https://www.dsh-plugin.shop/registry/all.json',
]

const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

const fresh = (cache) => cache && Date.now() - Date.parse(cache.fetchedAt ?? 0) < TTL_HOURS * 3600_000

const fetchFirst = async () => {
  for (const url of SOURCES) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!response.ok) {
        console.warn(`plugin-tags: ${url} -> HTTP ${response.status}`)
        continue
      }
      const document = await response.json()
      const items = Array.isArray(document?.items) ? document.items : Array.isArray(document) ? document : []
      if (!items.length) continue
      const tags = {}
      for (const item of items) {
        const name = String(item?.package ?? item?.name ?? '')
        const list = Array.isArray(item?.tags) ? item.tags.filter((tag) => typeof tag === 'string' && tag) : []
        if (!name || !list.length) continue
        tags[name] = list.slice(0, MAX_TAGS)
      }
      console.log(`plugin-tags: ${url} -> ${items.length} rows, ${Object.keys(tags).length} with tags`)
      return { fetchedAt: new Date().toISOString(), source: url, tags }
    } catch (error) {
      console.warn(`plugin-tags: ${url} -> ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return null
}

const index = await readJson(INDEX, { plugins: [] })
const known = new Set((index.plugins ?? []).map((plugin) => String(plugin.name ?? '')).filter(Boolean))
if (!known.size) {
  console.error('plugin-tags: the index has no plugins')
  process.exit(1)
}

let cache = await readJson(CACHE, null)
if (!fresh(cache)) {
  const fetched = await fetchFirst()
  if (fetched) {
    cache = fetched
    await mkdir(dirname(CACHE), { recursive: true })
    await writeFile(CACHE, JSON.stringify(cache))
  } else if (!cache) {
    // No network and no cache: writing an empty document would delete real data from the
    // published site, so leave the previous one alone and say so.
    console.warn('plugin-tags: no source reachable and no cache; keeping the existing document')
    process.exit(0)
  }
}

const tags = {}
for (const [name, list] of Object.entries(cache?.tags ?? {})) {
  if (known.has(name)) tags[name] = list
}

const document = {
  format: 'dsh-plugin-tags',
  schema: 1,
  generatedAt: new Date().toISOString(),
  count: Object.keys(tags).length,
  source: cache?.source,
  tags,
}
const text = JSON.stringify(document)
for (const path of OUT) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text + '\n')
}
console.log(
  `plugin-tags: ${document.count} names with tags (${((Buffer.byteLength(text) / 1024) | 0)} KB) from ${cache?.source ?? 'cache'}`,
)
