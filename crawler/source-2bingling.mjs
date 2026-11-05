// Adapter for 2BingLing/dsh-market (the largest community catalogue, 18k entries).
//
// Unlike the other sources this is NOT a format-1 index: its plugins-lite.json is a
// custom document whose entries describe GitHub-hosted plugins installed with
// `dsh plugin add`, and many of those names do not exist on npm at all. To honour
// "everything in our index must be installable":
//   - a name that resolves on npm keeps a normal npm source (the crawl re-gates it);
//   - a name that does not is emitted with a git source pointing at the repository
//     and a pinned commit, which the validator accepts ({type:'git',url,commit});
//   - `skill` entries are not DSH plugins and are skipped entirely.
//
// Deduplication happens at the caller: records are only merged for names the crawl
// does not already know, so an existing (verified) entry is never replaced.
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const API = 'https://api.github.com/repos/2BingLing/dsh-market/contents/data/plugins-lite.json?ref=master'
const CACHE = join(root, 'data', '2bingling-cache.json')
const COMMIT_CACHE = join(root, 'data', '2bingling-commits.json')
const MIN_STARS = Number(process.env.BINGLING_MIN_STARS || 1)
const MAX_GIT_LOOKUPS = Number(process.env.BINGLING_MAX_GIT_LOOKUPS || 600)

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
const headers = {
  accept: 'application/vnd.github+json',
  'user-agent': 'dsh-market-crawler/1.0',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
}

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

let document
try {
  const cached = JSON.parse(await readFile(CACHE, 'utf8'))
  // Reuse the 13.8 MB document until the upstream catalogue regenerates it.
  if (cached.generatedAt && cached.plugins) document = cached
} catch { /* first run */ }
if (!document) {
  const res = await fetch(API, { headers: { ...headers, accept: 'application/vnd.github.raw+json' }, signal: AbortSignal.timeout(120000) })
  if (!res.ok) throw new Error(`2BingLing HTTP ${res.status}`)
  document = JSON.parse(await res.text())
  await writeFile(CACHE, JSON.stringify(document))
}

let commitCache = {}
try { commitCache = JSON.parse(await readFile(COMMIT_CACHE, 'utf8')) } catch { /* first run */ }

async function commitFor(fullName, branch) {
  const cached = commitCache[fullName]
  if (cached !== undefined) return cached
  try {
    const repo = await gh(`/repos/${fullName}`)
    const ref = await gh(`/repos/${fullName}/commits/${encodeURIComponent(branch || repo.default_branch || 'main')}`)
    const sha = String(ref.sha ?? '')
    commitCache[fullName] = /^[0-9a-f]{40}$/.test(sha) ? sha : null
  } catch { commitCache[fullName] = null }
  return commitCache[fullName]
}

const NPM_CONCURRENCY = Number(process.env.BINGLING_NPM_CONCURRENCY || 24)
const NPM_CACHE = join(root, 'data', '2bingling-npm.json')
let npmCache = {}
try { npmCache = JSON.parse(await readFile(NPM_CACHE, 'utf8')) } catch { /* first run */ }

// A cheap existence check; only names that fail need a git source. Cached by name so
// repeat runs only probe entries that appeared since the last crawl.
async function onNpm(name) {
  if (typeof npmCache[name] === 'boolean') return npmCache[name]
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(8000),
    })
    npmCache[name] = res.ok
  } catch { npmCache[name] = false }
  return npmCache[name]
}

const candidates = (document.plugins ?? [])
  .filter((plugin) => plugin.type === 'cordis-plugin')
  .filter((plugin) => (plugin.stars ?? 0) >= MIN_STARS)
  .filter((plugin) => typeof plugin.name === 'string' && /^[a-z0-9][\w.-]*$/i.test(plugin.name))
  .filter((plugin) => /^[^/\s]+\/[^/\s]+$/.test(String(plugin.fullName ?? '')))

// Resolve npm availability in parallel BEFORE the main loop. One serial probe per
// name (10 s timeout each) used to stall this step for over an hour on 10k entries.
const unresolved = [...new Set(candidates.map((plugin) => plugin.name).filter((name) => typeof npmCache[name] !== 'boolean'))]
let cursor = 0
await Promise.all(Array.from({ length: NPM_CONCURRENCY }, async () => {
  while (cursor < unresolved.length) {
    const name = unresolved[cursor++]
    await onNpm(name)
  }
}))
await writeFile(NPM_CACHE, JSON.stringify(npmCache))
console.log(`2BingLing npm probe: ${unresolved.length} new names (${Object.keys(npmCache).length} cached)`)

let gitLookups = 0
let skipped = 0
const byName = new Map()
for (const plugin of candidates) {
  const name = plugin.name
  const key = name.toLowerCase()
  const repoUrl = `https://github.com/${plugin.fullName}.git`
  const base = {
    name,
    origins: new Set(['src-2bingling']),
    trust: new Set(['trust-source-index']),
    hintRepo: `https://github.com/${plugin.fullName}`,
    repo: `https://github.com/${plugin.fullName}`,
    stars: plugin.stars || undefined,
    hintCategory: 'other',
    title: { en: name, zh: name },
    description: {
      en: String(plugin.description ?? '').trim() || name,
      zh: String(plugin.descriptionZh ?? plugin.description ?? '').trim() || name,
    },
    hintEngines: plugin.install?.dshEngines,
    hintPublishTimestamp: Date.parse(plugin.pushedAt ?? '') / 1000 || 0,
    hintIcon: undefined,
    hintVersion: undefined,
    installCommand: (plugin.install?.commands ?? [])[0],
  }
  // One record per name. A git-sourced (npm-404) record wins over a plain npm one,
  // because it carries a pinned commit and is therefore actually installable.
  const keep = (record) => {
    const prior = byName.get(key)
    if (!prior || (record.gitSource && !prior.gitSource)) byName.set(key, record)
  }
  if (npmCache[name] === true) {
    // npm will be re-gated by the crawl; nothing else to do here.
    keep(base)
    continue
  }
  if (gitLookups >= MAX_GIT_LOOKUPS) { skipped++; continue }
  gitLookups++
  const commit = await commitFor(plugin.fullName, plugin.install?.branch)
  if (!commit) { skipped++; continue }
  keep({
    ...base,
    // A commit-pinned git entry has no npm version. Use a valid SemVer placeholder:
    // the format-1 validator insists on exact SemVer, and `source.commit` is the
    // identity that actually determines what gets installed.
    hintVersion: '0.0.0',
    // A catalog-only entry that cannot be resolved on npm still has to be installable.
    gitSource: { type: 'git', url: repoUrl, commit },
  })
}
const out = [...byName.values()]

const OUT = join(root, 'data', '2bingling-records.json')
await writeFile(COMMIT_CACHE, JSON.stringify(commitCache))
// Sets cannot be serialized; the caller only needs the plain records.
await writeFile(OUT, JSON.stringify(out.map((record) => ({
  ...record,
  origins: [...record.origins],
  trust: [...record.trust],
}))))
console.log(`2BingLing: ${candidates.length} candidates -> ${out.length} installable (${gitLookups} git lookups, ${skipped} deferred/missing) -> ${OUT}`)
