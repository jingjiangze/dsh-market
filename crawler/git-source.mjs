// Gives entries that exist only in a catalog — no npm package behind them — a git
// install target, so they stop being browse-only.
//
// The schema allows `source: { type: 'git', url, commit, path? }` (verified in
// @deepseek-ai/dsh-plugin-market-index), and a commit-pinned git source is what DSH
// needs to install something npm never received.
//
// Deliberately conservative: only entries whose catalog declared an engines.dsh
// range (a signal it is a real DSH plugin), capped per run, and cached by repository
// so a re-run costs nothing.
//
//   GITHUB_TOKEN=... node crawler/git-source.mjs
//   node crawler/git-source.mjs --offline   # report only
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OFFLINE = process.argv.includes('--offline')
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
const CONCURRENCY = Number(process.env.GIT_SOURCE_CONCURRENCY || 8)
const BUDGET_MS = Number(process.env.GIT_SOURCE_BUDGET_MS || 8 * 60 * 1000)
const MAX_PER_RUN = Number(process.env.GIT_SOURCE_MAX || 600)
const CACHE_PATH = join(root, 'data', 'git-source-cache.json')

let cache = {}
try {
  cache = JSON.parse(await readFile(CACHE_PATH, 'utf8'))
} catch {
  cache = {}
}

const index = JSON.parse(await readFile(join(root, 'dist', 'index.json'), 'utf8'))
const plugins = index.plugins ?? []

function repoSlug(plugin) {
  const url = String(plugin.repository?.url ?? '').trim().replace(/\.git$/, '')
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)$/i)
  return match ? { owner: match[1], repo: match[2], url } : null
}

// A candidate is a catalog-only entry that claims compatibility and is still on npm
// as its source (nothing to install from, because that package does not exist).
const candidates = []
for (const plugin of plugins) {
  const labels = plugin.metadata?.labels ?? []
  if (!labels.includes('catalog-only')) continue
  if (labels.includes('no-engines')) continue
  const version = plugin.versions?.[0]
  if (!version || version.source?.type !== 'npm') continue
  const slug = repoSlug(plugin)
  if (!slug) continue
  candidates.push({ plugin, version, slug })
}

if (OFFLINE) {
  const known = candidates.filter((c) => cache[`${c.slug.owner}/${c.slug.repo}`]).length
  console.log(`git-source: ${candidates.length} candidate(s), ${known} already cached`)
  process.exit(0)
}

const started = Date.now()
const outOfTime = () => Date.now() - started > BUDGET_MS
let cursor = 0
let resolved = 0
let failed = 0
let requests = 0

async function commitFor(slug) {
  const key = `${slug.owner}/${slug.repo}`
  const cached = cache[key]
  if (cached) return cached
  if (requests >= MAX_PER_RUN) return null
  requests++
  const res = await fetch(`https://api.github.com/repos/${key}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-market-git-source',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(15000),
  })
  if (res.status === 403 || res.status === 429) throw new Error('rate-limited')
  if (!res.ok) {
    cache[key] = { commit: null, at: Date.now() }
    return null
  }
  const body = await res.json()
  const branch = body.default_branch || 'main'
  const commitRes = await fetch(`https://api.github.com/repos/${key}/commits/${branch}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-market-git-source',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!commitRes.ok) {
    cache[key] = { commit: null, at: Date.now() }
    return null
  }
  const commitBody = await commitRes.json()
  const sha = String(commitBody.sha ?? '')
  cache[key] = /^[0-9a-f]{40}$/.test(sha) ? { commit: sha, at: Date.now() } : { commit: null, at: Date.now() }
  return cache[key]
}

async function worker() {
  while (cursor < candidates.length && !outOfTime() && requests < MAX_PER_RUN) {
    const entry = candidates[cursor++]
    let result = null
    try {
      result = await commitFor(entry.slug)
    } catch {
      break // rate limited: keep what we have
    }
    if (!result?.commit) {
      failed++
      continue
    }
    // Commit-pinned git source: the reader installs exactly what we inspected.
    entry.version.source = { type: 'git', url: `${entry.slug.url}.git`, commit: result.commit }
    resolved++
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))
await writeFile(join(root, 'dist', 'index.json'), JSON.stringify(index) + '\n')
await writeFile(CACHE_PATH, JSON.stringify(cache))
console.log(`git-source: ${resolved} entries switched to git (${requests} repo lookups, ${failed} skipped, ${candidates.length} candidates)`)
