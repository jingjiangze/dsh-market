// Fill `engines.dsh` from the package manifest.
//
// Format 1 defines `engines.dsh` as "SemVer range of DSH versions the version runs on;
// absent means any DSH version". A client that gets no range cannot pre-check, so an
// incompatible plugin installs and then fails — the brewreel npm case, "incompatible
// version" halfway through an install. The crawler only sees catalogue rows, and most of
// them never carried the range: measured on the live document, 4,717 of 6,946 npm entries
// had no `engines.dsh`.
//
// The manifest has it. One GET of `/<name>/latest` returns `engines` and the package size,
// which is also what the site shows as 安装体积. Cached by name so a run only pays for
// names it has never seen.
//
//   node crawler/probe-manifest.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = join(root, 'dist', 'index.json')
const CACHE = join(root, 'data', 'npm-manifest.json')
const CONCURRENCY = Number(process.env.MANIFEST_CONCURRENCY || 24)
const TIMEOUT_MS = Number(process.env.MANIFEST_TIMEOUT_MS || 10000)
const BUDGET_MS = Number(process.env.MANIFEST_BUDGET_MS || 480000)
const TTL_DAYS = Number(process.env.MANIFEST_TTL_DAYS || 14)
const LIMIT = Number(process.env.MANIFEST_LIMIT || 0)
const REGISTRIES = [
  (name) => `https://registry.npmmirror.com/${name.replace('/', '%2F')}/latest`,
  (name) => `https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`,
]

if (!existsSync(INDEX)) { console.error('probe-manifest: dist/index.json is missing'); process.exit(1) }
const index = JSON.parse(await readFile(INDEX, 'utf8'))
const plugins = index.plugins ?? []

let cache = {}
try { cache = JSON.parse(await readFile(CACHE, 'utf8')) } catch { cache = {} }
const fresh = (entry) => entry && Date.now() - Date.parse(entry.at ?? 0) < TTL_DAYS * 86400000

const wanted = []
for (const plugin of plugins) {
  const version = plugin.versions?.[0]
  if (!version || (version.source?.type ?? 'npm') !== 'npm') continue
  // A catalogue range is not authoritative: measured on dsh-ops the catalogue said
  // >=0.2.0-0 <0.3.0-0 while the package declares >=0.2.2-rc.1 <0.2.3-0. Fetch every npm
  // entry and let the manifest win.
  if (fresh(cache[plugin.name])) continue
  wanted.push(plugin.name)
}
const targets = LIMIT > 0 ? wanted.slice(0, LIMIT) : wanted
console.log(`probe-manifest: ${wanted.length} npm entries without engines.dsh (${Object.keys(cache).length} cached)` + (LIMIT ? `, capped at ${targets.length}` : ''))

async function manifestFor(name) {
  for (const url of REGISTRIES) {
    try {
      const res = await fetch(url(name), { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'dsh-market-manifest' } })
      if (res.status === 404) continue
      if (!res.ok) continue
      const body = await res.json()
      const range = typeof body?.engines?.dsh === 'string' ? body.engines.dsh.trim() : null
      const size = Number(body?.dist?.unpackedSize ?? 0)
      return { at: new Date().toISOString(), enginesDsh: range, unpackedSize: Number.isFinite(size) && size > 0 ? size : null }
    } catch {
      // Try the next registry; a timeout is not evidence the range is absent.
    }
  }
  return { at: new Date().toISOString(), enginesDsh: null, unpackedSize: null }
}

const started = Date.now()
let cursor = 0
let done = 0
async function worker() {
  while (cursor < targets.length) {
    if (Date.now() - started > BUDGET_MS) return
    const name = targets[cursor++]
    cache[name] = await manifestFor(name)
    done++
    if (done % 1000 === 0) console.log(`  fetched ${done}/${targets.length} (${((Date.now() - started) / 1000).toFixed(0)}s)`)
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length || 1) }, worker))

// Apply: engines into the version block, size into the sidecar the site reads.
let filled = 0
let corrected = 0
let sized = 0
for (const plugin of plugins) {
  const version = plugin.versions?.[0]
  if (!version) continue
  const record = cache[plugin.name]
  if (record?.enginesDsh) {
    const previous = version.engines?.dsh
    if (previous !== record.enginesDsh) {
      version.engines = { ...(version.engines ?? {}), dsh: record.enginesDsh }
      if (previous) corrected++
      else filled++
    }
  }
  if (record?.unpackedSize) {
    plugin._sidecar = { ...(plugin._sidecar ?? {}), size: Math.round((record.unpackedSize / 1048576) * 10) / 10 }
    sized++
  }
}

await mkdir(dirname(CACHE), { recursive: true })
await writeFile(CACHE, JSON.stringify(cache) + '\n')
await writeFile(INDEX, JSON.stringify(index) + '\n')

const npmTotal = plugins.filter((p) => (p.versions?.[0]?.source?.type ?? 'npm') === 'npm').length
const npmWith = plugins.filter((p) => (p.versions?.[0]?.source?.type ?? 'npm') === 'npm' && p.versions?.[0]?.engines?.dsh).length
console.log(`probe-manifest: filled engines on ${filled} entries, corrected ${corrected} stale range(s), size on ${sized}; npm coverage ${npmWith}/${npmTotal} (${((npmWith / Math.max(1, npmTotal)) * 100).toFixed(1)}%) in ${((Date.now() - started) / 1000).toFixed(0)}s`)
