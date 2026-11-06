// Builds the compact, chunked index the page browses, plus the icon fallback chain.
// The full format-1 document is ~11.5 MB for ~11k plugins (every language, long
// descriptions) — that is what made the page take seconds. This emits:
//   dist/browse/meta.json   totals, categories, sortKeys
//   dist/browse/<n>.json    800 entries each, ordered by stars
//
//   node crawler/browse.mjs
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHUNK = Number(process.env.BROWSE_CHUNK || 800)
const DESC_LIMIT = Number(process.env.BROWSE_DESC_LIMIT || 160)
const MIN_PLUGINS = Number(process.env.BROWSE_MIN_PLUGINS || 500)
const FORCE = process.env.BROWSE_FORCE === '1' || process.argv.includes('--force')
const OUT = join(root, 'dist', 'browse')

const pick = (value, lang) => (typeof value === 'string' ? value : (value?.[lang] ?? ''))
const trim = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, DESC_LIMIT)

// Icon chain the reader asked for:
//   1. the icon the package itself ships (`i`)
//   2. the GitHub project's own artwork is NOT used: its opengraph card is a
//      1200x630 white canvas that reads as a broken image once loaded
//   3. the developer's avatar (`g`, the account that owns the repository)
//   4. the CSS dot, when none of the above exists
function repoParts(repoUrl) {
  const match = String(repoUrl ?? '').match(/github\.com[/:]([^/]+)\/([^/#?]+)/i)
  return match ? { owner: match[1], repo: match[2].replace(/\.git$/i, '') } : null
}

const ICON_BASE = process.env.ICON_BASE
  || 'https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/web/icons'
// Icons are mirrored into the dataset by crawler/icons.mjs; when a URL has a
// mirrored copy the entry points at the dataset and keeps the origin as fallback.
const iconCache = await readFile(join(root, 'data', 'icons-cache.json'), 'utf8')
  .then((text) => JSON.parse(text).files ?? {})
  .catch(() => ({}))
const mirrored = (url) => (url && iconCache[url]?.name ? `${ICON_BASE}/${iconCache[url].name}` : null)

const index = JSON.parse(await readFile(join(root, 'dist', 'index.json'), 'utf8'))
const rawPlugins = index.plugins ?? []
// The sidecar carries what the crawl learned about each package (unpacked size,
// where the Chinese text came from, integrity/attestation records, gate list); the
// detail view shows a few of those.
const sidecar = await readFile(join(root, 'dist', 'index.sidecar.json'), 'utf8')
  .then((text) => {
    const map = new Map()
    for (const entry of JSON.parse(text).plugins ?? []) map.set(entry.name, entry)
    return map
  })
  .catch(() => new Map())
if (rawPlugins.length < MIN_PLUGINS && !FORCE) {
  console.error(`browse: refusing to publish ${rawPlugins.length} plugins (< ${MIN_PLUGINS}); set BROWSE_FORCE=1 to override`)
  process.exit(1)
}

const plugins = rawPlugins.map((plugin) => {
  const version = plugin.versions?.[0] ?? {}
  const entry = {
    n: plugin.name,
    t: pick(plugin.title, 'zh') || pick(plugin.title, 'en'),
    e: pick(plugin.title, 'en'),
    d: trim(pick(plugin.description, 'zh') || pick(plugin.description, 'en')),
    de: trim(pick(plugin.description, 'en')),
    c: plugin.metadata?.category ?? 'other',
    v: version.version ?? '',
    p: version.publishTimestamp ?? 0,
  }
  const stars = plugin.metadata?.sortKeys?.stars
  const downloads = plugin.metadata?.sortKeys?.downloads
  if (stars > 0) entry.s = stars
  if (downloads > 0) entry.dl = downloads
  const labels = plugin.metadata?.labels ?? []
  if (labels.length) entry.l = labels
  if (plugin.author) entry.a = String(plugin.author).slice(0, 40)
  if (plugin.repository?.url) entry.r = plugin.repository.url
  // Use-case ids and the practical score travel with the entry so the quiz, the
  // use-case filters and the 实用分 badge need no second pass over the index.
  const ucIds = (plugin.metadata?.keywords ?? []).filter((k) => String(k).startsWith('uc:')).map((k) => String(k).slice(3))
  if (ucIds.length) entry.u = ucIds
  if (plugin.metadata?.sortKeys?.score != null) entry.sc = plugin.metadata.sortKeys.score
  if (plugin.homepage) entry.h = plugin.homepage
  // Icon chain: dataset copy first, the origin as the fallback the browser uses if
  // that file is missing.
  if (plugin.icon) {
    entry.i = mirrored(plugin.icon) ?? plugin.icon
    if (entry.i !== plugin.icon) entry.ib = plugin.icon
  } else {
    const parts = repoParts(plugin.repository?.url)
    if (parts) {
      const avatar = `https://github.com/${parts.owner}.png?size=48`
      entry.g = mirrored(avatar) ?? avatar
      if (entry.g !== avatar) entry.gb = avatar
    }
  }
  // The GitHub opengraph card is deliberately NOT part of the chain: it is a
  // 1200x630 white canvas that loads fine and then looks like a broken image.
  // Extra detail for the modal that a card does not need.
  const keywords = plugin.metadata?.keywords ?? []
  if (keywords.length) entry.kw = keywords.slice(0, 8)
  const engines = plugin.versions?.[0]?.engines?.dsh
  if (engines) entry.eg = String(engines)
  // Which install source the entry declares: git entries are pinned to a commit, so
  // the site can show a distinct trust badge without a backend.
  if (plugin.versions?.[0]?.source?.type === 'git') entry.src = 'git'
  const meta = sidecar.get(plugin.name)
  if (meta) {
    if (meta.unpackedSize > 0) entry.sz = Math.round(meta.unpackedSize / 1048576 * 10) / 10
    if (meta.zhSource) entry.zh = meta.zhSource
    if (meta.gates?.length) entry.gn = meta.gates.length
    if (meta.distIntegrity) entry.dg = 1
    if (meta.attestations) entry.at = 1
    if (meta.origins?.length > 1) entry.on = meta.origins.length
  }
  const extra = ['ja', 'ko', 'ru']
    .map((lang) => [lang, pick(plugin.title, lang), trim(pick(plugin.description, lang))])
    .filter(([, title, desc]) => title || desc)
  if (extra.length) entry.x = extra
  return entry
})

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
// ── similar entries ────────────────────────────────────────────────────────
// Steam shows "more like this" on every page. The static equivalent: rank by shared
// use cases first, then same category, then practical score, and keep the six best
// names. Names rather than indexes, so a stale chunk can never point at the wrong
// plugin.
{
  const casesOf = (entry) => new Set(entry.u ?? [])
  const prepared = plugins.map((entry) => ({ entry, cases: casesOf(entry) }))
  for (const { entry, cases } of prepared) {
    const candidates = []
    for (const other of prepared) {
      if (other.entry.n === entry.n) continue
      let overlap = 0
      for (const id of other.cases) if (cases.has(id)) overlap++
      const sameCategory = other.entry.c === entry.c
      if (!overlap && !sameCategory) continue
      candidates.push({ name: other.entry.n, score: overlap * 3 + (sameCategory ? 2 : 0), sc: other.entry.sc ?? 0 })
    }
    if (!candidates.length) continue
    candidates.sort((a, b) => b.score - a.score || b.sc - a.sc)
    entry.sim = candidates.slice(0, 6).map((item) => item.name)
  }
  const withSim = plugins.filter((entry) => entry.sim).length
  console.log(`browse: similar links on ${withSim}/${plugins.length} entries`)
}

const chunks = []
for (let i = 0; i < plugins.length; i += CHUNK) {
  const name = `${i / CHUNK}.json`
  const slice = plugins.slice(i, i + CHUNK)
  const text = JSON.stringify(slice)
  await writeFile(join(OUT, name), text)
  chunks.push({ name, count: slice.length, bytes: Buffer.byteLength(text) })
}

const meta = {
  updatedAt: new Date().toISOString(),
  total: plugins.length,
  chunk: CHUNK,
  chunks: chunks.map((entry) => entry.name),
  categories: index.metadata?.categories ?? {},
  sortKeys: index.metadata?.sortKeys ?? {},
}
await writeFile(join(OUT, 'meta.json'), JSON.stringify(meta))

const withIcon = plugins.filter((entry) => entry.i).length
const withAvatar = plugins.filter((entry) => !entry.i && entry.g).length
console.log(`browse: ${plugins.length} plugins in ${chunks.length} chunks, first ${(chunks[0].bytes / 1024).toFixed(0)} KB, total ${(chunks.reduce((sum, c) => sum + c.bytes, 0) / 1048576).toFixed(2)} MB (full index ${(Buffer.byteLength(JSON.stringify(index)) / 1048576).toFixed(2)} MB)`)
console.log(`browse: icons — ${withIcon} from the package, ${withAvatar} from the repository owner, ${plugins.length - withIcon - withAvatar} dot`)
