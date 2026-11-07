// Pin the entries whose npm source does not exist.
//
// crawler/probe-npm.mjs found 54% of the catalogue claims an npm package that is missing
// from every registry. Those rows are real GitHub projects, so instead of dropping them we
// resolve their default-branch commit and publish a commit-pinned git source — which is a
// source DSH can actually install from.
//
// git-source.mjs already does this with the REST API: two requests per repository, capped at
// 600 a run, so 5,941 entries would take ten runs. GraphQL answers 100 repositories in ONE
// request (the same lesson 2BingLing recorded for its decay scan), so the whole backlog fits
// in a single run.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
const INDEX = join(root, 'dist', 'index.json')
const PROBE = join(root, 'data', 'npm-probe.json')
const CACHE = join(root, 'data', 'git-source-cache.json')
const BATCH = Number(process.env.PIN_BATCH || 100)
const CONCURRENCY = Number(process.env.PIN_CONCURRENCY || 3)
const BUDGET_MS = Number(process.env.PIN_BUDGET_MS || 600000)
const MAX_PINS = Number(process.env.PIN_MAX || 2500)
// GraphQL returns rateLimit alongside the data, so the loop can stop well before the
// token is dry and leave the REST quota the publish step needs.
const RATE_FLOOR = Number(process.env.PIN_RATE_FLOOR || 900)
let graphRemaining = null

if (!TOKEN) { console.error('pin-missing: GITHUB_TOKEN is missing'); process.exit(1) }
if (!existsSync(INDEX)) { console.error('pin-missing: dist/index.json is missing'); process.exit(1) }

const index = JSON.parse(await readFile(INDEX, 'utf8'))
const plugins = index.plugins ?? []
let probe = {}
try { probe = JSON.parse(await readFile(PROBE, 'utf8')) } catch { probe = {} }
let cache = {}
try { cache = JSON.parse(await readFile(CACHE, 'utf8')) } catch { cache = {} }

const slugOf = (plugin) => {
  const url = String(plugin.repository?.url ?? '').trim().replace(/\.git$/, '')
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)$/i)
  return match ? { owner: match[1], repo: match[2], url } : null
}

const candidates = []
for (const plugin of plugins) {
  const version = plugin.versions?.[0]
  if (!version) continue
  const source = version.source ?? {}
  // Already installable from a registry or already pinned: nothing to do.
  if (source.type === 'git' && /^[0-9a-f]{40}$/i.test(String(source.commit ?? ''))) continue
  const result = probe[plugin.name]
  if (!result) continue
  if (result.npmmirror === 'ok' || result.npmjs === 'ok') continue
  const slug = slugOf(plugin)
  if (!slug) continue
  const key = `${slug.owner}/${slug.repo}`
  // A cached pin is not an applied pin: dist/index.json is rebuilt from the catalogues on
  // every crawl, so an entry that was pinned last run comes back as an npm source. Skipping
  // it here meant the pin never reached the document and the entry was withheld as
  // uninstallable — 5,349 entries lost on the 2026-11-07 run for exactly this reason.
  candidates.push({ plugin, version, slug, key })
}
console.log(`pin-missing: ${candidates.length} entries claim a missing npm package and can be pinned to a commit`)
if (!candidates.length) process.exit(0)

const wanted = new Map()
for (const candidate of candidates) {
  // Cached keys still need to reach the document, but they need no request.
  const cached = cache[candidate.key]?.commit
  if (!cached && wanted.size >= MAX_PINS && !wanted.has(candidate.key)) continue
  if (!wanted.has(candidate.key)) wanted.set(candidate.key, [])
  wanted.get(candidate.key).push(candidate)
}
// Resolve only what the cache does not already know.
const keys = [...wanted.keys()].filter((key) => !cache[key]?.commit).slice(0, MAX_PINS)
console.log(`pin-missing: ${wanted.size} entries need a git source, ${keys.length} need a request`)

const QUERY = (batch) => `query{rateLimit{remaining}${batch
  .map((key, i) => {
    const [owner, repo] = key.split('/')
    return `r${i}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}){defaultBranchRef{target{oid}}}`
  })
  .join(' ')}}`

async function resolveBatch(batch) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'user-agent': 'dsh-market-pin' },
    body: JSON.stringify({ query: QUERY(batch) }),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`graphql ${res.status}`)
  const json = await res.json()
  if (!json.data) throw new Error(json.errors?.[0]?.message ?? 'graphql without data')
  if (typeof json.data.rateLimit?.remaining === "number") graphRemaining = json.data.rateLimit.remaining
  const now = Date.now()
  batch.forEach((key, i) => {
    const node = json.data[`r${i}`]
    const sha = String(node?.defaultBranchRef?.target?.oid ?? '')
    cache[key] = /^[0-9a-f]{40}$/i.test(sha) ? { commit: sha, at: now } : { commit: null, at: now }
  })
}

const started = Date.now()
let done = 0
let failed = 0
for (let i = 0; i < keys.length; i += BATCH * CONCURRENCY) {
  if (graphRemaining !== null && graphRemaining < RATE_FLOOR) {
    console.log(`pin-missing: stopping with ${graphRemaining} GraphQL points left (floor ${RATE_FLOOR}); the rest is pinned next run`)
    break
  }
  if (Date.now() - started > BUDGET_MS) { console.log(`pin-missing: budget reached after ${i}/${keys.length}`); break }
  const slices = []
  for (let s = 0; s < CONCURRENCY; s++) {
    const slice = keys.slice(i + s * BATCH, i + (s + 1) * BATCH)
    if (slice.length) slices.push(resolveBatch(slice))
  }
  const settled = await Promise.allSettled(slices)
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') done += outcome.value ?? BATCH
    else failed++
  }
  if (done % (BATCH * CONCURRENCY * 3) === 0) console.log(`  batches ${Math.min(i + BATCH * CONCURRENCY, keys.length)}/${keys.length}`)
}

// Apply: a resolved commit turns the row into a real git install target.
let applied = 0
for (const [key, list] of wanted) {
  const commit = cache[key]?.commit
  if (!commit || !/^[0-9a-f]{40}$/i.test(commit)) continue
  for (const { version, slug } of list) {
    version.source = { type: 'git', url: `${slug.url}.git`, commit }
    applied++
  }
}

await mkdir(dirname(CACHE), { recursive: true })
await writeFile(CACHE, JSON.stringify(cache) + '\n')
await writeFile(INDEX, JSON.stringify(index) + '\n')
const pinned = keys.filter((key) => cache[key]?.commit).length
console.log(`pin-missing: resolved ${pinned}/${keys.length} commits (${failed} failed batches), applied to ${applied} entries in ${((Date.now() - started) / 1000).toFixed(0)}s`)
