// Registry availability probe.
//
// The catalogue carries two kinds of rows: npm packages we verified against the registry
// in the crawl that produced them, and "catalog-only" rows that came from a community
// list — 95% of the catalogue — whose `source` still claims `{type:'npm'}` even though
// nobody ever checked. DSH probes a package before installing, so those rows fail there
// ("more than half the entries do not exist on any public registry").
//
// This asks both registries directly (HEAD only, no body) and records the answer, so the
// index can be honest about what is installable and the site can show which mirror a
// reader should use.
//
// Results are cached in data/npm-probe.json and committed: a re-run only probes names it
// has never seen or whose cache entry is older than PROBE_TTL_DAYS.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(root, 'data', 'npm-probe.json')
const INDEX = [join(root, 'dist', 'index.json'), join(root, 'site', 'index.zh.json')].find((p) => existsSync(p))
if (!INDEX) { console.error('probe-npm: no index found'); process.exit(1) }

const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY || 40)
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 8000)
const LIMIT = Number(process.env.PROBE_LIMIT || 0) // 0 = every name
const TTL_DAYS = Number(process.env.PROBE_TTL_DAYS || 14)
const BUDGET_MS = Number(process.env.PROBE_BUDGET_MS || 600000)
const REGISTRIES = [
  { id: 'npmmirror', url: (name) => `https://registry.npmmirror.com/${name.replace('/', '%2F')}` },
  { id: 'npmjs', url: (name) => `https://registry.npmjs.org/${name.replace('/', '%2F')}` },
]

let cache = {}
try { cache = JSON.parse(await readFile(CACHE, 'utf8')) } catch { cache = {} }

const index = JSON.parse(await readFile(INDEX, 'utf8'))
const plugins = index.plugins ?? []
const npmRows = plugins.filter((plugin) => (plugin.versions?.[0]?.source?.type ?? 'npm') === 'npm')
console.log(`probe-npm: ${plugins.length} plugins, ${npmRows.length} claim an npm source`)

const fresh = (entry) => entry && Date.now() - Date.parse(entry.checkedAt ?? 0) < TTL_DAYS * 86400000
const todo = []
for (const plugin of npmRows) {
  if (fresh(cache[plugin.name])) continue
  todo.push(plugin.name)
}
const targets = LIMIT > 0 ? todo.slice(0, LIMIT) : todo
console.log(`  ${todo.length} need probing (${Object.keys(cache).length} cached, ttl ${TTL_DAYS}d)` + (LIMIT ? `, capped at ${targets.length}` : ''))

async function head(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'dsh-market-probe' } })
    if (res.status === 200) return 'ok'
    if (res.status === 404) return 'missing'
    return `http-${res.status}`
  } catch {
    return 'error'
  }
}

const started = Date.now()
let cursor = 0
let done = 0
async function worker() {
  while (cursor < targets.length) {
    if (Date.now() - started > BUDGET_MS) return
    const name = targets[cursor++]
    const result = { checkedAt: new Date().toISOString() }
    for (const registry of REGISTRIES) {
      result[registry.id] = await head(registry.url(name))
      // A mirror hit is enough; skip the second call.
      if (result[registry.id] === 'ok') break
    }
    cache[name] = result
    done++
    if (done % 500 === 0) console.log(`  probed ${done}/${targets.length} (${((Date.now() - started) / 1000).toFixed(0)}s)`)
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length || 1) }, worker))

await mkdir(dirname(CACHE), { recursive: true })
await writeFile(CACHE, JSON.stringify(cache) + '\n')

// Report against the whole catalogue, not just this run's slice.
let ok = 0, missing = 0, error = 0, unknown = 0
for (const plugin of npmRows) {
  const entry = cache[plugin.name]
  if (!entry) { unknown++; continue }
  if (entry.npmmirror === 'ok' || entry.npmjs === 'ok') ok++
  else if (entry.npmmirror === 'missing' && entry.npmjs === 'missing') missing++
  else error++
}
const pct = (n) => `${((n / npmRows.length) * 100).toFixed(1)}%`
console.log(`probe-npm: on a registry ${ok} (${pct(ok)}), missing everywhere ${missing} (${pct(missing)}), inconclusive ${error}, unprobed ${unknown}`)
console.log(`probe-npm: wrote ${CACHE.replace(root, '.')} in ${((Date.now() - started) / 1000).toFixed(0)}s`)
