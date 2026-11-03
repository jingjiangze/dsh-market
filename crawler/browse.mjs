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

// developer icon = the GitHub account that owns the repository
function avatarFor(repoUrl) {
  const match = String(repoUrl ?? '').match(/github\.com[/:]([^/]+)\//i)
  return match ? `https://github.com/${match[1]}.png?size=80` : null
}

const index = JSON.parse(await readFile(join(root, 'dist', 'index.json'), 'utf8'))
const rawPlugins = index.plugins ?? []
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
  if (plugin.homepage) entry.h = plugin.homepage
  // Icon chain: the package's own icon, else the repository owner's avatar.
  if (plugin.icon) entry.i = plugin.icon
  else {
    const avatar = avatarFor(plugin.repository?.url)
    if (avatar) entry.g = avatar
  }
  const extra = ['ja', 'ko', 'ru']
    .map((lang) => [lang, pick(plugin.title, lang), trim(pick(plugin.description, lang))])
    .filter(([, title, desc]) => title || desc)
  if (extra.length) entry.x = extra
  return entry
})

await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })
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
