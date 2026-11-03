// Fills the two numbers a catalog often lacks: GitHub stars per repository and
// weekly npm downloads per package. Both live behind public APIs, so this runs as
// its own CI step with a token, a hard budget and a content cache — a re-run only
// asks about what changed, and a rate-limited run still publishes everything it
// managed to refresh.
//
//   node crawler/enrich.mjs
//   node crawler/enrich.mjs --offline   # report coverage only
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OFFLINE = process.argv.includes('--offline')
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
const CONCURRENCY = Number(process.env.ENRICH_CONCURRENCY || 10)
const BUDGET_MS = Number(process.env.ENRICH_BUDGET_MS || 8 * 60 * 1000)
const MAX_REPOS = Number(process.env.ENRICH_MAX_REPOS || 3500)
const MAX_DOWNLOADS = Number(process.env.ENRICH_MAX_DOWNLOADS || 3000)
const CACHE_TTL_MS = Number(process.env.ENRICH_TTL_MS || 3 * 24 * 60 * 60 * 1000)
const started = Date.now()
const outOfTime = () => Date.now() - started > BUDGET_MS

const cachePath = join(root, 'data', 'enrich-cache.json')
let cache = { repos: {}, downloads: {} }
try {
  const loaded = JSON.parse(await readFile(cachePath, 'utf8'))
  cache = { repos: loaded.repos ?? {}, downloads: loaded.downloads ?? {} }
} catch {
  cache = { repos: {}, downloads: {} }
}

const index = JSON.parse(await readFile(join(root, 'dist', 'index.json'), 'utf8'))
const plugins = index.plugins ?? []

// "https://github.com/owner/repo(.git)" -> "owner/repo"; anything else is skipped.
function repoSlug(plugin) {
  const url = plugin.repository?.url ?? plugin.repository?.repo ?? ''
  const match = String(url).match(/github\.com[/:]([^/]+)\/([^/#?]+)/i)
  if (!match) return null
  return `${match[1]}/${match[2].replace(/\.git$/i, '')}`
}

const fresh = (entry) => entry && Date.now() - (entry.at ?? 0) < CACHE_TTL_MS

async function githubStars(slug) {
  const res = await fetch(`https://api.github.com/repos/${slug}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-market-enrich',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(15000),
  })
  if (res.status === 403 || res.status === 429) {
    // Out of quota: stop asking, keep what we have.
    throw new Error('rate-limited')
  }
  if (res.status === 404) return { stars: null, at: Date.now() }
  if (!res.ok) return null
  const body = await res.json()
  return { stars: Number(body.stargazers_count) || 0, at: Date.now() }
}

async function npmDownloads(name) {
  const url = `https://api.npmjs.org/downloads/point/last-week/${name.replace('/', '%2f')}`
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': 'dsh-market-enrich' }, signal: AbortSignal.timeout(15000) })
    // 404 means "listed in a catalog but never published to npm" — cache that too,
    // otherwise every run burns a request on the same ~3k names.
    if (res.status === 404) return { downloads: 0, at: Date.now() }
    // npm's point API answers 429 when bursts arrive; one short backoff, then give up
    // for this run (the cache keeps whatever landed).
    if (res.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
      continue
    }
    if (!res.ok) return null
    const body = await res.json()
    return { downloads: Number(body.downloads) || 0, at: Date.now() }
  }
  return null
}

if (OFFLINE) {
  const needStars = plugins.filter((p) => !(p.metadata?.sortKeys?.stars > 0) && repoSlug(p)).length
  const needDownloads = plugins.filter((p) => !(p.metadata?.sortKeys?.downloads > 0)).length
  console.log(`enrich: ${plugins.length} plugins, ${needStars} missing stars (repo known), ${needDownloads} missing downloads`)
  process.exit(0)
}

// ---- stars: one GitHub call per distinct repository, cached for CACHE_TTL_MS ----
const starTargets = new Map()
for (const plugin of plugins) {
  if (plugin.metadata?.sortKeys?.stars > 0) continue
  const slug = repoSlug(plugin)
  if (slug) starTargets.set(slug, true)
}
let starLookups = 0
let starsAdded = 0
const slugs = [...starTargets.keys()].slice(0, MAX_REPOS)
let cursor = 0
let rateLimited = false
async function starWorker() {
  while (cursor < slugs.length && !outOfTime() && !rateLimited) {
    const slug = slugs[cursor++]
    let entry = cache.repos[slug]
    if (!fresh(entry)) {
      try {
        const result = await githubStars(slug)
        starLookups++
        if (result) {
          entry = result
          cache.repos[slug] = entry
        }
      } catch (err) {
        if (String(err.message).includes('rate-limited')) {
          rateLimited = true
          break
        }
      }
    }
    if (entry?.stars > 0) {
      for (const plugin of plugins) {
        if (!(plugin.metadata?.sortKeys?.stars > 0) && repoSlug(plugin) === slug) {
          plugin.metadata.sortKeys = { ...(plugin.metadata?.sortKeys ?? {}), stars: entry.stars }
          starsAdded++
        }
      }
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slugs.length || 1) }, starWorker))

// ---- weekly downloads: npm's public point API, cached the same way ----
const downloadTargets = []
for (const plugin of plugins) {
  if (!(plugin.metadata?.sortKeys?.downloads > 0)) downloadTargets.push(plugin)
}
let downloadLookups = 0
let downloadsAdded = 0
const downloadQueue = downloadTargets.slice(0, MAX_DOWNLOADS)
let downloadCursor = 0
async function downloadWorker() {
  while (downloadCursor < downloadQueue.length && !outOfTime()) {
    const plugin = downloadQueue[downloadCursor++]
    let entry = cache.downloads[plugin.name]
    if (!fresh(entry)) {
      const result = await npmDownloads(plugin.name).catch(() => null)
      downloadLookups++
      if (result) {
        entry = result
        cache.downloads[plugin.name] = entry
      }
    }
    if (entry?.downloads > 0) {
      plugin.metadata.sortKeys = { ...(plugin.metadata?.sortKeys ?? {}), downloads: entry.downloads }
      downloadsAdded++
    }
  }
}
// npm's point API rate-limits bursts, so this pass runs with its own narrow
// concurrency and a try/catch: a throttled run keeps whatever already landed.
const DOWNLOAD_CONCURRENCY = Math.min(3, CONCURRENCY)
try {
  await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, downloadQueue.length || 1) }, downloadWorker))
} catch (error) {
  console.log(`enrich: downloads pass aborted (${error.message})`)
}

await writeFile(join(root, 'dist', 'index.json'), JSON.stringify(index, null, 2) + '\n')
await writeFile(cachePath, JSON.stringify(cache) + '\n')

const starsNow = plugins.filter((p) => p.metadata?.sortKeys?.stars > 0).length
const downloadsNow = plugins.filter((p) => p.metadata?.sortKeys?.downloads > 0).length
const zeroStarRepos = Object.values(cache.repos).filter((entry) => entry.stars === 0).length
const missingOnNpm = Object.values(cache.downloads).filter((entry) => entry.downloads === 0).length
console.log(`enrich: ${starsAdded} stars added (${starLookups} lookups, ${slugs.length} candidates${rateLimited ? ', rate limited' : ''}) -> ${starsNow}/${plugins.length}`)
console.log(`enrich: ${downloadsAdded} downloads added (${downloadLookups} lookups) -> ${downloadsNow}/${plugins.length}`)
console.log(`enrich: ${zeroStarRepos} cached repos have zero stars, ${missingOnNpm} cached packages are not on npm`)
