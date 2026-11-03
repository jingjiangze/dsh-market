// Mirrors the icons the catalogue points at into the dataset, so the page does not
// depend on github.com / jsDelivr for artwork:
//   - package icons (235 files, from the npm/jsDelivr path)
//   - one avatar per distinct GitHub owner (6874 owners at last audit)
//
// Files are cached by URL hash in data/icons-cache.json, so a run only downloads
// what is new and only rewrites files whose bytes changed.
//
//   node crawler/icons.mjs
//   node crawler/icons.mjs --offline   # report only
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OFFLINE = process.argv.includes('--offline')
const CONCURRENCY = Number(process.env.ICON_CONCURRENCY || 12)
const BUDGET_MS = Number(process.env.ICON_BUDGET_MS || 12 * 60 * 1000)
const AVATAR_SIZE = Number(process.env.ICON_AVATAR_SIZE || 48)
const OUT = join(root, 'dist', 'icons')
const CACHE_PATH = join(root, 'data', 'icons-cache.json')
const started = Date.now()

const cacheOrg = await readFile(CACHE_PATH, 'utf8').then(JSON.parse).catch(() => ({ files: {} }))
const cache = { files: cacheOrg.files ?? {} }

const index = JSON.parse(await readFile(join(root, 'dist', 'index.json'), 'utf8'))
const plugins = index.plugins ?? []

// url -> local file name
const targets = new Map()
for (const plugin of plugins) {
  if (plugin.icon) targets.set(plugin.icon, true)
  const owner = String(plugin.repository?.url ?? '').match(/github\.com[/:]([^/]+)\//i)?.[1]
  if (owner) targets.set(`https://github.com/${owner}.png?size=${AVATAR_SIZE}`, true)
}

const nameFor = (url) => {
  const ext = url.includes('.png') ? 'png' : url.match(/\.(svg|jpg|jpeg|webp|gif)(\?|$)/i)?.[1] ?? 'png'
  return `${createHash('sha1').update(url).digest('hex').slice(0, 20)}.${ext}`
}

const urls = [...targets.keys()]
if (OFFLINE) {
  const missing = urls.filter((url) => !cache.files[url])
  console.log(`icons: ${urls.length} url(s), ${missing.length} not cached yet`)
  process.exit(0)
}

await mkdir(OUT, { recursive: true })
let downloaded = 0
let bytes = 0
let failed = 0
let cursor = 0
const outOfTime = () => Date.now() - started > BUDGET_MS

async function worker() {
  while (cursor < urls.length && !outOfTime()) {
    const url = urls[cursor++]
    const name = nameFor(url)
    const cached = cache.files[url]
    if (cached?.name === name) {
      const exists = await stat(join(OUT, name)).then(() => true).catch(() => false)
      if (exists) continue
    }
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'dsh-market-icons' }, signal: AbortSignal.timeout(15000) })
      if (!res.ok) { failed++; continue }
      const buffer = Buffer.from(await res.arrayBuffer())
      if (buffer.length < 64) { failed++; continue }
      await writeFile(join(OUT, name), buffer)
      cache.files[url] = { name, bytes: buffer.length, at: Date.now() }
      downloaded++
      bytes += buffer.length
    } catch {
      failed++
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))
await writeFile(CACHE_PATH, JSON.stringify(cache))
console.log(`icons: ${urls.length} url(s), ${downloaded} fetched (${(bytes / 1048576).toFixed(1)} MB), ${failed} failed, ${Object.keys(cache.files).length} cached`)
