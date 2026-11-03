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

const SOURCES = {
  dshso: { label: 'src-dshso', url: process.env.DSHSO_INDEX || 'https://cdn.dsh.so/market/index.json' },
  awesome: { label: 'src-awesome', url: process.env.AWESOME_INDEX || 'https://cdn.jsdelivr.net/npm/awesome-dsh-plugin-feed/data/market-v2.json' },
  mydsh: { label: 'src-mydsh', url: process.env.MYDSH_INDEX || 'https://www.mydsh.xyz/market/index.json' },
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
      title: { en: textOf(plugin.title), zh: textOf(plugin.title) },
      description: { en: textOf(plugin.description), zh: textOf(plugin.description) },
      repo: plugin.repository?.url,
      stars: plugin.metadata?.sortKeys?.stars,
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
      record.repo ??= entry.repo
      record.stars ??= Number(entry.stars) || undefined
      record.description ??= { en: String(entry.summary ?? ''), zh: String(entry.summary ?? '') }
      found.set(parsed.name, record)
    }
  }
  return [...found.values()]
}

// Returns Map<name, {name, origins:Set, trust:Set, hintEngines?, title?, description?, repo?, stars?}>
export async function discoverFederated(log = console.log) {
  const enabled = String(process.env.SOURCES ?? 'dshso,awesome,mydsh')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => SOURCES[name])
  const merged = new Map()

  await Promise.all(enabled.map(async (key) => {
    const source = SOURCES[key]
    try {
      const document = await getJSON(source.url)
      const records = key === 'dshso'
        ? fromFormatOne(document, source.label)
        : key === 'mydsh'
          ? fromMydsh(document, source.label)
          : fromRepoTargets(document, source.label)
      for (const record of records) {
        const existing = merged.get(record.name)
        if (!existing) {
          merged.set(record.name, record)
          continue
        }
        for (const origin of record.origins) existing.origins.add(origin)
        for (const trust of record.trust) existing.trust.add(trust)
        existing.hintEngines ??= record.hintEngines
        existing.description ??= record.description
        existing.title ??= record.title
        existing.repo ??= record.repo
        existing.stars ??= record.stars
      }
      log(`source ${key}: ${records.length} npm candidates`)
    } catch (err) {
      log(`source ${key}: skipped (${err.message})`)
    }
  }))

  return merged
}
