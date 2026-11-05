import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Federated discovery: read the other public catalogs and turn their entries into
// npm package names our own gates can verify.
//
//   dsh.so        already ships a format-1 market index (10k+ plugins, bilingual
//                 titles) — the richest source, read directly.
//   awesome       repository entries carrying `packages.targets[]` npm specs.
//   mydsh.xyz     a flat catalog without install targets; its entry names are
//                 tried as npm package names and dropped when they are not.
//
// Nothing here is trusted as fact: a source's version and engines are only hints
// for ordering and for filling display text. The crawl re-resolves the newest
// compatible version from the npm registry and re-gates it.
const UA = 'dsh-market-crawler/1.0 (+https://github.com/jingjiangze/dsh-market)'
const MAX_BYTES = Number(process.env.SOURCE_MAX_BYTES || 16 * 1024 * 1024)

// Only the GitHub discovery path needs these; the catalogue readers stay pure fetch.
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const SOURCES = {
  dshso: { label: 'src-dshso', url: process.env.DSHSO_INDEX || 'https://cdn.dsh.so/market/index.json' },
  awesome: { label: 'src-awesome', url: process.env.AWESOME_INDEX || 'https://cdn.jsdelivr.net/npm/awesome-dsh-plugin-feed/data/market-v2.json' },
  mydsh: { label: 'src-mydsh', url: process.env.MYDSH_INDEX || 'https://www.mydsh.xyz/market/index.json' },
  // Open Plugin Market (github.com/polang233/dsh-plugin-index): a real format-1 index,
  // 1k plugins, 326 KB gzipped, served straight from GitHub Pages.
  polang: { label: 'src-polang', url: process.env.POLANG_INDEX || 'https://polang233.github.io/dsh-plugin-index/index.json' },
}

const NPM_SPEC = /^((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)(?:@([\w.^~<>=|-]+))?$/i

async function getJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(90000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > MAX_BYTES) throw new Error(`catalog too large (${declared} B)`)
  const text = await res.text()
  if (text.length > MAX_BYTES) throw new Error(`catalog too large (${text.length} chars)`)
  return JSON.parse(text)
}

const textOf = (value) => (typeof value === 'string' ? value : value?.zh || value?.en || '')

function npmNameFromTarget(target) {
  const spec = String(target?.source ?? target?.install ?? '').trim()
  const bare = spec.startsWith('npm:') ? spec.slice(4) : spec
  if (!bare || /^(github|git|url|file|link):/i.test(bare) || /^https?:/i.test(bare)) return null
  if (bare.includes('#') || bare.includes('&path:')) return null
  const match = NPM_SPEC.exec(bare)
  return match ? { name: match[1], pinned: match[2] } : null
}

// dsh.so: a real format-1 index. Read name / newest version / engines / display text.
function fromFormatOne(document, label) {
  const records = []
  for (const plugin of document?.plugins ?? []) {
    if (typeof plugin?.name !== 'string' || !plugin.name) continue
    const versions = Array.isArray(plugin.versions) ? plugin.versions : []
    const newest = versions.slice().sort((a, b) => String(b?.version).localeCompare(String(a?.version), 'en', { numeric: true }))[0]
    records.push({
      name: plugin.name,
      origins: new Set([label]),
      trust: new Set(['trust-source-index']),
      hintEngines: newest?.engines?.dsh ?? plugin.metadata?.engines?.dsh,
      hintCategory: plugin.category ?? plugin.metadata?.category,
      // Which vocabulary hintCategory comes from; the taxonomy picks its mapping
      // table by this so identically-named categories in different catalogs (e.g.
      // dsh.so `tools` vs the official curated `tools`) are not conflated.
      hintSource: label,
      // Carried straight from the catalog so an entry we could not re-verify this
      // run can still be published with its real version and publish time.
      hintVersion: newest?.version,
      hintPublishTimestamp: newest?.publishTimestamp,
      hintIcon: plugin.icon,
      hintRepo: plugin.repository?.url ?? plugin.repository?.repo ?? plugin.repository,
      title: { en: textOf(plugin.title), zh: textOf(plugin.title) },
      description: { en: textOf(plugin.description), zh: textOf(plugin.description) },
      repo: plugin.repository?.url,
      stars: plugin.metadata?.sortKeys?.stars,
      downloads: plugin.metadata?.sortKeys?.downloads,
    })
  }
  return records
}

// awesome-dsh-plugin: repository entries with `packages.targets[]` install specs.
function fromRepoTargets(document, label) {
  const entries = document?.plugins ?? document?.entries ?? []
  const found = new Map()
  for (const entry of entries) {
    const status = entry?.packages?.verification?.status
    const trust = status === 'readme-verified' ? 'trust-readme-verified' : status === 'repo-fallback' ? 'trust-repo-fallback' : null
    for (const target of entry?.packages?.targets ?? []) {
      const parsed = npmNameFromTarget(target)
      if (!parsed) continue
      const record = found.get(parsed.name) ?? { name: parsed.name, origins: new Set(), trust: new Set() }
      record.origins.add(label)
      if (trust) record.trust.add(trust)
      record.hintCategory ??= entry.category
      record.hintSource ??= label
      record.repo ??= entry.full_name
      record.description ??= { en: String(entry.description ?? ''), zh: String(entry.description ?? '') }
      record.stars ??= entry.stargazers_count
      found.set(parsed.name, record)
    }
  }
  return [...found.values()]
}

// mydsh.xyz: flat catalog, no install targets; the entry names are the only handle.
function fromMydsh(document, label) {
  const found = new Map()
  for (const entry of document?.plugins ?? []) {
    for (const candidate of [entry?.name, String(entry?.repo ?? '').split('/').pop()]) {
      if (!candidate) continue
      const parsed = npmNameFromTarget({ install: String(candidate) })
      if (!parsed) continue
      const record = found.get(parsed.name) ?? { name: parsed.name, origins: new Set(), trust: new Set() }
      record.origins.add(label)
      record.trust.add('trust-unpinned')
      record.hintCategory ??= entry.category
      record.hintSource ??= label
      record.repo ??= entry.repo
      record.stars ??= Number(entry.stars) || undefined
      record.description ??= { en: String(entry.summary ?? ''), zh: String(entry.summary ?? '') }
      found.set(parsed.name, record)
    }
  }
  return [...found.values()]
}

// GitHub discovery: the catalogues above only know what somebody already listed, and
// a monorepo can publish a dozen DSH plugins that never appear in any catalogue
// (github.com/ShiroEirin/dsh-web-ui ships 19 packages, none of which the three
// catalogues mention). Repos are found by topic and by name, then every
// package.json inside them is inspected for a `dsh` manifest section.
const GH = 'https://api.github.com'
const GH_CACHE = join(root, 'data', 'github-discovery-cache.json')
const GH_QUERIES = [
  'topic:dsh-market',
  'dsh-plugin in:name',
  'topic:dsh-plugin',
]
const GH_MAX_REPOS = Number(process.env.GH_MAX_REPOS || 150)
const GH_MAX_PACKAGES = Number(process.env.GH_MAX_PACKAGES || 40)

async function ghJSON(path, token) {
  const res = await fetch(`${GH}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': UA,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(25000),
  })
  if (res.status === 403 || res.status === 429) throw new Error('rate-limited')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// A package.json qualifies when it carries a dsh section or a dsh keyword: that is
// what makes it a DSH plugin rather than an ordinary npm package in the same repo.
function packageRecord(pkg, repoUrl, stars, label) {
  // The validator only accepts lowercase npm names; monorepos sometimes contain
  // template manifests like "dsh-client-ui-__NAME__" that must not be published.
  if (!pkg || typeof pkg.name !== 'string' || !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(pkg.name) || pkg.name.length > 214) return null
  const dsh = pkg.dsh
  const keywords = Array.isArray(pkg.keywords) ? pkg.keywords.map((k) => String(k).toLowerCase()) : []
  const looksDsh = Boolean(dsh?.bundle?.patch || dsh?.client || dsh?.plugin) || keywords.includes('dsh-plugin') || keywords.some((k) => k.startsWith('dsh-'))
  if (!looksDsh) return null
  const title = String(pkg.name)
  const description = String(pkg.description ?? '').trim()
  return {
    name: pkg.name,
    origins: new Set([label]),
    trust: new Set(['trust-unpinned']),
    hintEngines: dsh?.engines?.dsh,
    hintVersion: typeof pkg.version === 'string' ? pkg.version : undefined,
    hintRepo: repoUrl,
    repo: repoUrl,
    stars,
    title: { en: title, zh: title },
    description: { en: description, zh: description },
  }
}

export async function discoverGitHub(token, log = console.log) {
  const found = new Map()
  if (process.env.SOURCES && !process.env.SOURCES.split(',').includes('github')) {
    log('github: disabled by SOURCES')
    return found
  }
  if (!token) {
    log('github: no token, skipped')
    return found
  }
  let cache = {}
  try { cache = JSON.parse(await readFile(GH_CACHE, 'utf8')) } catch { cache = {} }

  // 1. Which repositories claim to be DSH plugin repos.
  const repos = new Map()
  for (const query of GH_QUERIES) {
    try {
      const page = await ghJSON(`/search/repositories?q=${encodeURIComponent(query)}&per_page=100&sort=stars`, token)
      for (const repo of page.items ?? []) {
        if (repo.archived || repo.fork) continue
        if (!repos.has(repo.full_name)) {
          repos.set(repo.full_name, { stars: repo.stargazers_count ?? 0, branch: repo.default_branch || 'main', pushed: repo.pushed_at })
        }
      }
      log(`github ${query}: ${(page.items ?? []).length} repos`)
    } catch (err) {
      log(`github ${query}: skipped (${err.message})`)
      if (/rate-limited/.test(err.message)) break
    }
  }

  // Repositories named in data/github-seed-repos.json are always inspected, even when
  // they are too new or too unstarred to reach the top of a search page — a monorepo
  // with zero stars can still ship twenty real plugins.
  const seeds = new Set()
  try {
    const list = JSON.parse(await readFile(join(root, 'data', 'github-seed-repos.json'), 'utf8'))
    for (const name of Array.isArray(list) ? list : []) seeds.add(name)
  } catch { /* optional */ }
  for (const fullName of seeds) {
    if (repos.has(fullName)) continue
    try {
      const repo = await ghJSON(`/repos/${fullName}`, token)
      if (repo.archived) continue
      repos.set(fullName, { stars: repo.stargazers_count ?? 0, branch: repo.default_branch || 'main', pushed: repo.pushed_at })
    } catch { /* a missing seed simply does not contribute */ }
  }

  const inspected = [...repos.entries()].filter(([name], index) => index < GH_MAX_REPOS || seeds.has(name))
  log(`github: inspecting ${inspected.length} repos (${seeds.size} seed(s))`)

  for (const [fullName, meta] of inspected) {
    const cached = cache[fullName]
    // Reuse the previous package list until the repository is pushed to again.
    if (cached && cached.pushed === meta.pushed && Array.isArray(cached.packages)) {
      for (const pkg of cached.packages) {
        const record = packageRecord(pkg, `https://github.com/${fullName}`, meta.stars, 'src-github')
        if (record && !found.has(record.name)) found.set(record.name, record)
      }
      continue
    }
    try {
      const tree = await ghJSON(`/repos/${fullName}/git/trees/${meta.branch}?recursive=1`, token)
      const paths = (tree.tree ?? [])
        .filter((entry) => entry.type === 'blob' && /(^|\/)package\.json$/.test(entry.path))
        .map((entry) => entry.path)
        .filter((path) => path.split('/').length <= 3)
        .slice(0, GH_MAX_PACKAGES)
      const packages = []
      for (const path of paths) {
        try {
          const file = await ghJSON(`/repos/${fullName}/contents/${path}?ref=${meta.branch}`, token)
          if (!file?.content) continue
          const pkg = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'))
          const record = packageRecord(pkg, `https://github.com/${fullName}`, meta.stars, 'src-github')
          if (record) {
            packages.push({ name: pkg.name, version: pkg.version, description: pkg.description, keywords: pkg.keywords, dsh: pkg.dsh })
            if (!found.has(record.name)) found.set(record.name, record)
          }
        } catch { /* one unreadable package.json must not stop the repo */ }
      }
      cache[fullName] = { pushed: meta.pushed, packages }
    } catch (err) {
      if (/rate-limited/.test(err.message)) { log('github: rate limited, stopping'); break }
    }
  }

  try { await writeFile(GH_CACHE, JSON.stringify(cache)) } catch { /* cache is best effort */ }
  log(`github: ${found.size} packages`)
  return found
}

// Returns Map<name, {name, origins:Set, trust:Set, hintEngines?, title?, description?, repo?, stars?}>
export async function discoverFederated(log = console.log) {
  const enabled = String(process.env.SOURCES || 'dshso,awesome,mydsh,polang')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => SOURCES[name])
  const merged = new Map()

  await Promise.all(enabled.map(async (key) => {
    const source = SOURCES[key]
    try {
      const document = await getJSON(source.url)
      const records = key === 'mydsh'
        ? fromMydsh(document, source.label)
        : key === 'awesome'
          ? fromRepoTargets(document, source.label)
          : fromFormatOne(document, source.label)
      for (const record of records) {
        const existing = merged.get(record.name)
        if (!existing) {
          merged.set(record.name, record)
          continue
        }
        for (const origin of record.origins) existing.origins.add(origin)
        for (const trust of record.trust) existing.trust.add(trust)
        existing.hintEngines ??= record.hintEngines
        existing.hintCategory ??= record.hintCategory
        existing.hintVersion ??= record.hintVersion
        existing.hintPublishTimestamp ??= record.hintPublishTimestamp
        existing.hintIcon ??= record.hintIcon
        existing.hintRepo ??= record.hintRepo
        existing.description ??= record.description
        existing.title ??= record.title
        existing.repo ??= record.repo
        existing.stars ??= record.stars
        existing.downloads ??= record.downloads
      }
      log(`source ${key}: ${records.length} npm candidates`)
    } catch (err) {
      log(`source ${key}: skipped (${err.message})`)
    }
  }))

  return merged
}
