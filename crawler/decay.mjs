// Decay scan — the weekly "is the catalogue rotting?" report.
//
// Borrowed from 2BingLing/dsh-market's decay-scan, including the lesson recorded in
// their workflow: probing 5k+ repositories one REST call at a time burns the quota
// around request ~4800 and then crawls to a halt, so they moved to GraphQL batches of
// 100. This does the same: ~150 batches instead of ~15000 requests.
//
// It only REPORTS. Nothing is removed here; a human decides (see the tracking issue
// the workflow opens). Deleting on a heuristic would quietly shrink the catalogue on
// a bad network day.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
const BATCH = Number(process.env.DECAY_BATCH_SIZE || 100)
const CONCURRENCY = Number(process.env.DECAY_CONCURRENCY || 3)
const BUDGET_MS = Number(process.env.DECAY_BUDGET_MS || 720000)
const STALE_DAYS = Number(process.env.DECAY_STALE_DAYS || 365)
const OUT = join(root, 'data', 'decay-report.json')

const indexPaths = [join(root, 'dist', 'index.json'), join(root, 'site', 'index.zh.json')]
const indexPath = indexPaths.find((path) => existsSync(path))
if (!indexPath) {
  console.error('decay: no index found (run the crawl or check out main first)')
  process.exit(1)
}
const index = JSON.parse(await readFile(indexPath, 'utf8'))

// Only GitHub repositories can be probed this way.
const repoOf = (plugin) => {
  const raw = String(plugin?.repository?.url ?? '')
  const m = raw.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i)
  return m ? { owner: m[1], name: m[2].replace(/\.git$/i, ''), full: `${m[1]}/${m[2].replace(/\.git$/i, '')}` } : null
}
const repos = new Map()
for (const plugin of index.plugins ?? []) {
  const repo = repoOf(plugin)
  if (!repo) continue
  if (!repos.has(repo.full.toLowerCase())) repos.set(repo.full.toLowerCase(), { ...repo, plugins: [] })
  repos.get(repo.full.toLowerCase()).plugins.push(plugin.name)
}
const allRepos = [...repos.values()].sort((a, b) => a.full.localeCompare(b.full))
const MAX_REPOS = Number(process.env.DECAY_MAX_REPOS || 2500)
const week = Math.floor(Date.now() / (7 * 86400000))
const sliceCount = Math.max(1, Math.ceil(allRepos.length / MAX_REPOS))
const offset = (week % sliceCount) * MAX_REPOS
const targets = allRepos.slice(offset, offset + MAX_REPOS)
console.log(`decay: ${targets.length}/${allRepos.length} repositories this run (slice ${(week % sliceCount) + 1}/${sliceCount} of ${(index.plugins ?? []).length} plugins)`)

if (!TOKEN) {
  console.error('decay: GITHUB_TOKEN is missing')
  process.exit(1)
}

const RATE_FLOOR = Number(process.env.DECAY_RATE_FLOOR || 150)

async function batch(items) {
  const aliases = items.map((repo, i) => `r${i}:repository(owner:${JSON.stringify(repo.owner)},name:${JSON.stringify(repo.name)}){nameWithOwner isArchived isFork pushedAt}`)
  const body = JSON.stringify({ query: `query{rate:rateLimit{remaining} ${aliases.join(' ')}}` })
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'user-agent': 'dsh-market-decay',
    },
    body,
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`graphql ${res.status}`)
  const json = await res.json()
  // Only a response without data is a real batch failure (auth, rate limit, syntax).
  // Per-alias NOT_FOUND inside `errors` is expected and means "repository is gone".
  if (!json.data) throw new Error(json.errors?.[0]?.message ?? `graphql without data (${res.status})`)
  // NOT_FOUND is an answer ("this repository is gone"); a null node without that
  // error means the budget ran out and must never be reported as decay.
  const notFound = new Set()
  for (const error of json.errors ?? []) {
    const alias = Array.isArray(error?.path) ? String(error.path[0]) : ''
    if (error?.type === 'NOT_FOUND' && alias) notFound.add(alias)
  }
  return {
    remaining: json.data.rate?.remaining ?? null,
    results: items.map((repo, i) => {
      const alias = `r${i}`
      const node = json.data?.[alias] ?? null
      return { repo, node, gone: !node && notFound.has(alias) }
    }),
  }
}

const started = Date.now()
const batches = []
for (let i = 0; i < targets.length; i += BATCH) batches.push(targets.slice(i, i + BATCH))

const results = []
let remaining = null
let budgetExceeded = false
const errorSamples = []
let failedBatches = 0
for (let i = 0; i < batches.length; i += CONCURRENCY) {
  if (Date.now() - started > BUDGET_MS) {
    console.log(`decay: time budget reached after ${i}/${batches.length} batches — reporting partial results`)
    budgetExceeded = true
    break
  }
  if (budgetExceeded) break
  const slice = batches.slice(i, i + CONCURRENCY)
  const settled = await Promise.allSettled(slice.map((items) => batch(items)))
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      results.push(...outcome.value.results)
      if (outcome.value.remaining != null) remaining = Math.min(remaining ?? Infinity, outcome.value.remaining)
      if (remaining != null && remaining < RATE_FLOOR) {
        console.log(`decay: rate budget down to ${remaining} points — stopping with partial results`)
        budgetExceeded = true
      }
    }
    // A failed batch is recorded, never retried in a sleep loop: 2BingLing's incident
    // was exactly this loop pushing a 40-minute job past its ceiling.
    else {
      failedBatches++
      if (errorSamples.length < 5) errorSamples.push(String(outcome.reason?.message ?? outcome.reason).slice(0, 200))
    }
  }
}

const now = Date.now()
const notFound = []
const archived = []
const forks = []
const stale = []
const unknown = []
for (const { repo, node, gone } of results) {
  if (!node) {
    if (gone) notFound.push(repo.full)
    else unknown.push(repo.full)
    continue
  }
  if (node.isArchived) archived.push(repo.full)
  if (node.isFork) forks.push(repo.full)
  const pushed = node.pushedAt ? Date.parse(node.pushedAt) : 0
  if (pushed && (now - pushed) / 86400000 > STALE_DAYS) stale.push({ repo: repo.full, days: Math.round((now - pushed) / 86400000) })
}

const report = {
  checkedAt: new Date().toISOString(),
  source: indexPath.replace(root, '.'),
  repositories: targets.length,
  probed: results.length,
  failedBatches,
  errorSamples,
  budgetExceeded,
  counts: { notFound: notFound.length, archived: archived.length, forks: forks.length, stale: stale.length, unknown: unknown.length },
  rateRemaining: remaining,
  unknownSamples: unknown.slice(0, 20),
  notFound: notFound.slice(0, 500),
  archived: archived.slice(0, 500),
  forks: forks.slice(0, 500),
  stale: stale.sort((a, b) => b.days - a.days).slice(0, 500),
}
await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, JSON.stringify(report, null, 2) + '\n')
console.log(`decay: probed ${results.length}/${targets.length} — 404 ${notFound.length}, archived ${archived.length}, fork ${forks.length}, stale ${stale.length}, unverified ${unknown.length} (rate ${remaining ?? '-'})`)
console.log(`decay: wrote ${OUT.replace(root, '.')} (report only; nothing was removed)`)
if (!results.length) {
  console.error('decay: probed nothing — refusing to report a healthy catalogue')
  process.exit(1)
}
