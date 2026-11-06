// DSH plugin-market index crawler (zero dependencies, Node >= 18, ESM).
//
// Crawl npm for packages that declare a DSH bundle, apply admission gates, and
// emit a format-1 market index plus a sidecar and a rejection log.
//
//   node crawler/crawl.mjs                # default: npmjs registry, 200 plugins
//   NPM_REGISTRY=https://registry.npmmirror.com node crawler/crawl.mjs
//
// Gates are deliberately conservative: a false "compatible" claim is worse than
// a missing entry, because DSH checks compatibility twice (market from this
// index, install from the real package manifest).
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { discoverFederated, discoverGitHub } from './sources.mjs'
import { CATEGORIES, CATEGORY_GROUPS, categoryFor } from './taxonomy.mjs'
import { applyTranslations } from './i18n.mjs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, 'dist')

const REGISTRY = (process.env.NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '')
// Keyword search only works on the npm registry proper: npmmirror ignores the
// `keywords:` prefix and answers 0, so discovery stays on npmjs by default.
const SEARCH_REGISTRY = (process.env.SEARCH_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '')
// Retried requests fall back here; a mirror tolerates the crawl's burst better
// than npmjs does, and a manifest read from either registry is the same document.
const FALLBACK_REGISTRY = (process.env.FALLBACK_REGISTRY ?? 'https://registry.npmmirror.com').replace(/\/+$/, '')
const DSH_RUNTIME = process.env.DSH_RUNTIME_VERSION || '0.2.1-rc.5'
const MIN_AGE_DAYS = Number(process.env.MIN_AGE_DAYS || 3)
const MAX_PLUGINS = Number(process.env.MAX_PLUGINS || 1500)
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES || 4000)
const CONCURRENCY = Number(process.env.CONCURRENCY || 8)
// Parallel verification: CI runs N shards of the candidate list at once, each
// writing a part file, and one merge job unions them with the carried catalogue.
const SHARD = Number(process.env.SHARD ?? -1)
const SHARDS = Math.max(1, Number(process.env.SHARDS || 1))
const PART_OUT = process.env.PART_OUT || null
// Entries the shards could not verify this run are still published from the
// catalog they came from (slim: name/version/engines/display text), so the index
// is complete on day one instead of after dozens of crawl rounds.
const MERGE_EXTERNAL = process.env.MERGE_EXTERNAL !== '0'
const MAX_TOTAL = Number(process.env.MAX_TOTAL || 12000)
// Publish-only: skip network verification and rebuild the index from the carried
// catalogue plus the catalogs' own entries. The merge job of the sharded CI run
// uses this after the shards have uploaded their verified slices.
const PUBLISH_ONLY = process.argv.includes('--publish-only')
const QUERIES = (process.env.SEARCH_QUERIES || [
  'keywords:dsh-plugin',
  'keywords:deepseek-harness',
  'keywords:dsh',
].join(',')).split(',')

const UA = 'dsh-market-crawler/1.0 (+https://github.com/jingjiangze/dsh-market)'

// ---------------------------------------------------------------- utilities
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJSON(url, { accept = 'application/json', tries = 4 } = {}) {
  // A four-figure candidate set hammers the registry; retry with backoff and fall
  // back to the mirror instead of counting the miss as a rejected plugin.
  const fallbacks = []
  if (FALLBACK_REGISTRY && url.startsWith(REGISTRY)) fallbacks.push(FALLBACK_REGISTRY + url.slice(REGISTRY.length))
  let last
  for (let i = 0; i < tries; i++) {
    const target = i > 0 && fallbacks.length ? fallbacks[(i - 1) % fallbacks.length] : url
    try {
      const res = await fetch(target, {
        headers: { accept, 'user-agent': UA },
        signal: AbortSignal.timeout(30000),
      })
      if (res.status === 404) return { notFound: true }
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after') || 0)
        await sleep(retryAfter ? retryAfter * 1000 : 1200 * (i + 1) ** 2)
        last = new Error(`HTTP ${res.status}`)
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return { body: await res.json() }
    } catch (err) {
      last = err
      if (i < tries - 1) await sleep(800 * (i + 1) ** 2)
    }
  }
  throw last
}

function cmpSemverDesc(a, b) {
  const pa = a.split('-'), pb = b.split('-')
  const na = pa[0].split('.').map(Number), nb = pb[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) if (na[i] !== nb[i]) return nb[i] - na[i]
  if (pa[1] === pb[1]) return 0
  if (pa[1] === undefined) return -1
  if (pb[1] === undefined) return 1
  return pa[1] < pb[1] ? 1 : -1
}

// Deliberately small semver range check. Anything it cannot parse confidently
// returns null ("unknown"), and unknown is excluded — never assumed compatible.
function parseVersion(v) {
  const [core, pre] = String(v).split('-')
  const [major, minor, patch] = core.split('.').map((n) => Number(n))
  return { major, minor, patch, pre }
}

function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b)
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1
  if (x.pre === y.pre) return 0
  if (x.pre === undefined) return 1
  if (y.pre === undefined) return -1
  return x.pre > y.pre ? 1 : -1
}

function satisfiesComparator(version, comparator) {
  const m = comparator.match(/^(>=|<=|>|<|=|\^|~)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/)
  if (!m) return null
  const op = m[1] || '='
  const num = (s) => (s === undefined || /^[xX*]$/.test(s) ? null : Number(s))
  const major = num(m[2])
  if (major === null) return true // wildcard on major: any version
  const minor = num(m[3])
  const patch = num(m[4])
  const comparatorPre = m[5]

  // Semver nuance that matters here: a prerelease only participates when the
  // comparator itself carries one; `^0.2.1` must NOT accept `0.2.1-rc.5`.
  const candidate = comparatorPre ? version : String(version).split('-')[0]
  const bound = `${major}.${minor ?? 0}.${patch ?? 0}${comparatorPre ? `-${comparatorPre}` : ''}`
  const cmp = compareVersions(candidate, bound)

  switch (op) {
    case '>=': return cmp >= 0
    case '>': return cmp > 0
    case '<=': return cmp <= 0
    case '<': return cmp < 0
    case '=':
      if (minor === null) return parseVersion(version).major === major
      if (patch === null) return parseVersion(version).major === major && parseVersion(version).minor === minor
      return cmp === 0
    case '^': {
      if (cmp < 0) return false
      const v = parseVersion(version)
      if (major > 0) return v.major === major
      if (minor === null) return v.major === 0
      if (minor > 0) return v.major === 0 && v.minor === minor
      return v.major === 0 && v.minor === 0 && (patch === null || v.patch === patch)
    }
    case '~': {
      if (cmp < 0) return false
      const v = parseVersion(version)
      if (minor === null) return v.major === major
      return v.major === major && v.minor === minor
    }
    default: return null
  }
}

function satisfies(version, range) {
  if (!range) return null // undeclared: unknown, never claim compatibility
  const text = String(range).trim()
  if (!text) return null
  // An explicit wildcard means "any version" — that is a claim, not a gap.
  if (text === '*' || text === 'x' || text === 'X' || text === 'latest') return true
  let sawUnknown = false
  for (const alternative of text.split('||')) {
    const comparators = alternative.trim().split(/\s+/).filter(Boolean)
    if (!comparators.length) continue
    let ok = true, unknown = false
    for (const comparator of comparators) {
      const result = satisfiesComparator(version, comparator)
      if (result === null) unknown = true
      else if (result === false) ok = false
    }
    if (unknown) { sawUnknown = true; continue }
    if (ok) return true
  }
  return sawUnknown ? null : false
}

function localized(text) {
  // format 1 requires an English fallback in every language map.
  return { en: text, zh: text }
}

// ------------------------------------------------------------------ taxonomy
// Categories follow the shape community catalogs use (a declared id per plugin
// plus a bilingual title on the index), kept deliberately small so a reader can
// actually scan them.

// Only labels that change a reader's decision are published: which catalog listed
// the plugin, whether that catalog verified it, whether the Chinese text is still a
// placeholder, and — the way dsh.so does it — which popularity tier the package is
// in, so the list itself shows whether a plugin is established or brand new.
const KEEP_LABELS = new Set([
  'src-npm', 'src-dshso', 'src-awesome', 'src-mydsh', 'src-polang', 'src-official', 'src-github', 'src-2bingling',
  'trust-readme-verified', 'trust-repo-fallback',
  'zh-fallback',
  // Published from a catalog we could not re-verify this run: the reader should
  // know the compatibility claim is the catalog's, not ours.
  'no-engines', 'catalog-only',
  // Popularity tiers (generated, see tierLabels).
  'stars-hot', 'stars-mid', 'stars-new',
  'dl-hot', 'dl-mid',
  'install-verified',
])

// Tier labels. The validator allows any number of labels (only duplicates are
// rejected), so tiers do not have to displace the source/trust labels.
function tierLabels(stars, downloads, verified) {
  const tiers = []
  if (Number.isFinite(stars) && stars > 0) {
    if (stars >= 1000) tiers.push('stars-hot')
    else if (stars >= 100) tiers.push('stars-mid')
    else tiers.push('stars-new')
  }
  if (Number.isFinite(downloads) && downloads > 0) {
    if (downloads >= 1000) tiers.push('dl-hot')
    else if (downloads >= 100) tiers.push('dl-mid')
  }
  if (verified) tiers.push('install-verified')
  return tiers
}

function displayLabels(labels) {
  const kept = [...new Set((labels ?? []).filter((label) => KEEP_LABELS.has(label)))]
  // Flags first: "no-engines"/"catalog-only" are what the validator and the reader
  // rely on, so the budget must never squeeze them out in favour of a source.
  const flags = kept.filter((label) => label === 'no-engines' || label === 'catalog-only')
  const rest = kept.filter((label) => !flags.includes(label))
  // 5 fits a source + a trust/tier pair without turning the card into a wall.
  return [...flags, ...rest].slice(0, 5)
}

// --------------------------------------------------------------- localization
// Prefer the text the author already ships: a package's own `locale/zh.json`
// carries the localized title/description DSH shows, so no machine translation
// is invented here. Curated overrides cover packages that ship none, and the
// remainder falls back to English while saying so through a label.
let ZH_OVERRIDES = {}
try {
  ZH_OVERRIDES = JSON.parse(await readFile(join(root, 'data', 'zh-overrides.json'), 'utf8'))
} catch {
  ZH_OVERRIDES = {}
}

async function authorZh(name, version, enTitle, enDescription, catalogZh) {
  for (const file of ['locale/zh.json', 'locale/zh-CN.json', 'locale/zh_CN.json']) {
    try {
      const { body } = await getJSON(`https://cdn.jsdelivr.net/npm/${name}@${version}/${file}`)
      const meta = body?.meta
      if (meta && (meta.title || meta.description)) {
        return {
          title: meta.title ? String(meta.title) : undefined,
          description: meta.description ? String(meta.description) : undefined,
          source: 'native',
        }
      }
    } catch {
      // a missing locale file is the common case, not an error
    }
  }
  // A federated catalog often carries a Chinese title the package itself never
  // shipped. It is someone else's wording, so it ranks below the author's own.
  const hasCjk = (value) => /[\u4e00-\u9fff]/.test(String(value ?? ''))
  if (hasCjk(catalogZh?.title) || hasCjk(catalogZh?.description)) {
    return {
      title: hasCjk(catalogZh?.title) ? String(catalogZh.title) : undefined,
      description: hasCjk(catalogZh?.description) ? String(catalogZh.description) : undefined,
      source: 'catalog',
    }
  }
  const override = ZH_OVERRIDES[name]
  if (override?.title || override?.description) {
    // A curated entry stays usable after the package publishes a new version:
    // titles and one-line descriptions rarely change, and the sidecar records
    // which release it was written against for a later read-through.
    return {
      title: override.title,
      description: override.description,
      source: 'override',
      pinnedFor: override.version,
    }
  }
  // Many authors already write Chinese into the npm description. That is the
  // author's own wording, so prefer it to English even though it is not a
  // translation of it.
  const cjk = (value) => /[\u4e00-\u9fff]/.test(String(value ?? ''))
  if (cjk(enTitle) || cjk(enDescription)) {
    return { title: enTitle, description: enDescription, source: 'detected' }
  }
  return { source: 'fallback' }
}

function detectIcon(manifest) {
  const icon = manifest.icon
  if (typeof icon === 'string' && /\.(svg|png|jpe?g|webp)$/i.test(icon)) return icon.replace(/^\.\//, '')
  const exp = manifest.exports
  const sub = exp && typeof exp === 'object' ? exp['./icon'] : undefined
  if (typeof sub === 'string') return sub.replace(/^\.\//, '')
  if (sub && typeof sub === 'object' && typeof sub.default === 'string') return sub.default.replace(/^\.\//, '')
  return null
}

const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1)
const reason = (rejections, name, why, detail) => rejections.push({ name, why, detail })

// ------------------------------------------------------------------- crawl
async function search(query) {
  const url = `${SEARCH_REGISTRY}/-/v1/search?text=${encodeURIComponent(query)}&size=250`
  const { body, notFound } = await getJSON(url)
  if (notFound || !body?.objects) return []
  return body.objects.map((o) => o.package?.name).filter(Boolean)
}

async function main() {
  const started = Date.now()
  // A wall-clock budget keeps one slow registry from turning a scheduled crawl
  // into a 40-minute job: whatever is verified before the deadline is published,
  // and the rest stays queued for the next run.
  const deadline = started + Number(process.env.CRAWL_BUDGET_MS || 15 * 60 * 1000)
  // Phase 1 is cheap per item but there are many; phase 2 is what actually emits
  // plugins. Reserve the second half for phase 2 so a slow registry cannot leave
  // a run with a shortlist and no output.
  const phase1Deadline = started + (deadline - started) * 0.45
  const outOfTime = () => Date.now() > deadline
  const phase1OutOfTime = () => Date.now() > phase1Deadline
  const skipped = { phase1: 0, phase2: 0 }
  const rejections = []
  const counts = new Map()

  // 1. candidate discovery: our own keyword crawl, then the federated catalogs.
  //    Federation only contributes names and display text; every version is
  //    re-resolved from the npm registry and re-gated below.
  const provenance = new Map()
  const names = new Set()
  for (const q of QUERIES) {
    try {
      for (const n of await search(q)) {
        names.add(n)
        const entry = provenance.get(n) ?? { origins: new Set(), trust: new Set() }
        entry.origins.add('src-npm')
        provenance.set(n, entry)
      }
    } catch (err) {
      reason(rejections, `<query ${q}>`, 'search-failed', String(err.message || err))
    }
  }
  const federated = await discoverFederated()
  // The largest community catalogue (18k entries) is merged LAST and ONLY for names
  // nothing else knows. That is the "no duplicates" rule: an entry we already have
  // keeps its own stars, labels and trust, and 2BingLing never overwrites it.
  try {
    const extra = JSON.parse(await readFile(join(root, 'data', '2bingling-records.json'), 'utf8'))
    let added = 0
    // npm names are case-insensitive in practice; compare lowercased so "Knotline"
    // and "knotline" cannot slip through as two entries.
    const known = new Set([...federated.keys(), ...names].map((name) => String(name).toLowerCase()))
    for (const record of Array.isArray(extra) ? extra : []) {
      if (!record?.name) continue
      const key = String(record.name).toLowerCase()
      if (known.has(key)) continue
      known.add(key)
      federated.set(record.name, {
        ...record,
        origins: new Set(record.origins ?? ['src-2bingling']),
        trust: new Set(record.trust ?? ['trust-source-index']),
      })
      added++
    }
    console.log(`2BingLing merged: +${added} new names (duplicates skipped)`)
  } catch (error) {
    // Shards run before the adapter step, so the records file does not exist there
    // yet. That is expected; only the merge job consumes it.
    if (error?.code !== 'ENOENT') console.log(`2BingLing: skipped (${error.message})`)
  }
// GitHub repositories add what the catalogues miss: monorepos publishing many DSH
// plugins (ShiroEirin/dsh-web-ui ships 19) and plugins that were never listed.
const fromGitHub = await discoverGitHub(process.env.GITHUB_TOKEN || process.env.GH_TOKEN)
for (const [name, record] of fromGitHub) {
  const existing = federated.get(name)
  if (!existing) { federated.set(name, record); continue }
  for (const origin of record.origins) existing.origins.add(origin)
  existing.hintRepo ??= record.hintRepo
  existing.repo ??= record.repo
  existing.stars ??= record.stars
  existing.hintVersion ??= record.hintVersion
  existing.description ??= record.description
  existing.title ??= record.title
}
  for (const record of federated.values()) {
    names.add(record.name)
    const entry = provenance.get(record.name) ?? { origins: new Set(), trust: new Set() }
    for (const origin of record.origins) entry.origins.add(origin)
    for (const trust of record.trust) entry.trust.add(trust)
    // Carry everything the gates and the published index need: dropping these
    // here is why star counts and engine hints silently disappeared before.
    if (entry.stars === undefined) entry.stars = record.stars
    if (entry.downloads === undefined) entry.downloads = record.downloads
    if (entry.hintEngines === undefined) entry.hintEngines = record.hintEngines
    if (entry.title === undefined) entry.title = record.title
    if (entry.description === undefined) entry.description = record.description
    provenance.set(record.name, entry)
  }
  console.log(`candidates: ${names.size} total, ${federated.size} from federated catalogs`)

  // Federated names go first: they are already curated somewhere else, so they
  // deserve the limited verification budget more than arbitrary search hits.
  // A source's engines claim only orders the queue — the npm manifest decides.
  const rank = (name) => {
    const record = provenance.get(name)
    const hinted = record?.hintEngines ? satisfies(DSH_RUNTIME, record.hintEngines) === true : false
    return (hinted ? 2 : 0) + (record?.origins.size ?? 1)
  }
  const ordered = [...names].sort((a, b) => rank(b) - rank(a) || a.localeCompare(b))
  // Each parallel shard takes a striped slice of the same ordered pool, so N jobs
  // never verify the same package and together cover the whole list.
  const pool = SHARDS > 1 && SHARD >= 0 ? ordered.filter((_, index) => index % SHARDS === SHARD) : ordered
  // The pool is far larger than one run can verify, so the run resumes where the
  // previous one stopped: successive scheduled runs walk the whole pool over time
  // instead of re-checking the same popular head every time.
  let cursor = 0
  try {
    cursor = Number(JSON.parse(await readFile(join(root, 'data', 'cursor.json'), 'utf8')).offset) || 0
  } catch {
    cursor = 0
  }
  if (cursor >= pool.length) cursor = 0
  const rotated = [...pool.slice(cursor), ...pool.slice(0, cursor)]
  const candidates = rotated.slice(0, MAX_CANDIDATES)
  const nextCursor = pool.length ? (cursor + candidates.length) % pool.length : 0

  // 2. phase 1: cheap latest-manifest gate
  const shortlist = []
  for (let i = 0; !PUBLISH_ONLY && i < candidates.length; i += CONCURRENCY) {
    if (phase1OutOfTime()) {
      skipped.phase1 = candidates.length - i
      break
    }
    const batch = candidates.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async (name) => {
      try {
        const { body: m, notFound } = await getJSON(`${REGISTRY}/${name.replace('/', '%2f')}/latest`)
        if (notFound || !m) return reason(rejections, name, 'no-latest-version')
        if (!m.dsh?.bundle?.patch) return reason(rejections, name, 'not-a-bundle')
        if (m.scripts && ['preinstall', 'install', 'postinstall'].some((s) => m.scripts[s])) {
          return reason(rejections, name, 'has-install-script')
        }
        shortlist.push({ name, latest: m })
      } catch (err) {
        reason(rejections, name, 'manifest-fetch-failed', String(err.message || err))
      }
    }))
  }
  console.log(`shortlist (declares dsh bundle): ${shortlist.length}`)

  // 3. phase 2: pick the newest compatible version from the full packument
  const plugins = []
  for (let i = 0; !PUBLISH_ONLY && i < shortlist.length; i += CONCURRENCY) {
    if (outOfTime()) {
      skipped.phase2 = shortlist.length - i
      break
    }
    const batch = shortlist.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(async ({ name }) => {
      try {
        const { body: pack, notFound } = await getJSON(`${REGISTRY}/${name.replace('/', '%2f')}`)
        if (notFound || !pack?.versions) return reason(rejections, name, 'packument-missing')
        const versions = Object.keys(pack.versions).filter((v) => !v.includes('-')).sort(cmpSemverDesc)
        const now = Date.now()
        const ageOk = (v) => {
          const t = pack.time?.[v]
          if (!t) return false
          return now - Date.parse(t) >= MIN_AGE_DAYS * 86400_000
        }
        const compatible = versions.filter((v) => {
          const man = pack.versions[v]
          if (!man.dsh?.bundle?.patch) return false
          const declared = man.engines?.dsh
          const ok = satisfies(DSH_RUNTIME, declared)
          return ok === true // unknown ranges are excluded, not assumed
        })
        if (!compatible.length) return reason(rejections, name, 'no-version-declares-compatible-engines.dsh', `${DSH_RUNTIME}`)
        const live = compatible.filter(ageOk)
        if (!live.length) return reason(rejections, name, 'too-recent', `< ${MIN_AGE_DAYS}d old`)
        const version = live[0]
        const man = pack.versions[version]
        if (man.scripts && ['preinstall', 'install', 'postinstall'].some((s) => man.scripts[s])) {
          return reason(rejections, name, 'has-install-script', version)
        }
        if (!man.license || /^NOASSERTION|^UNLICENSED$/i.test(man.license)) {
          return reason(rejections, name, 'license-unclear', String(man.license))
        }
        const iconPath = detectIcon(man)
        const meta = man.metadata || {}
        const record = provenance.get(name)
        // The package's own strings win; a catalog's copy fills the gaps.
        const enTitle = meta.title ? String(meta.title) : record?.title?.en || name
        const enDescription = man.description
          ? String(man.description).slice(0, 280)
          : String(record?.description?.en || enTitle).slice(0, 280)
        const catalogZh = record?.title?.zh || record?.description?.zh
          ? { title: record?.title?.zh, description: record?.description?.zh }
          : undefined
        const zh = await authorZh(name, version, enTitle, enDescription, catalogZh)
        const category = categoryFor(record, name, enTitle, enDescription, (man.keywords || []).join(' '))
        // format 1 only allows http(s) URLs without credentials; an ssh or
        // git-protocol repository is dropped rather than breaking the document.
        const httpUrl = (value) => {
          const url = String(value ?? '').replace(/^git\+/, '').replace(/^git:/, 'https:').replace(/\.git$/, '')
          return /^https?:\/\//i.test(url) && !url.includes(' ') ? url : null
        }
        const repoUrl = httpUrl(man.repository?.url)
        const homeUrl = /^https?:\/\//i.test(String(man.homepage ?? '')) ? String(man.homepage) : null
        const publishTs = Math.floor(Date.parse(pack.time[version]) / 1000) || 0
        plugins.push({
          name,
          title: { en: enTitle, zh: zh.title || enTitle },
          description: { en: enDescription, zh: zh.description || enDescription },
          ...(iconPath ? { icon: `https://cdn.jsdelivr.net/npm/${name}@${version}/${iconPath}` } : {}),
          ...(typeof man.author === 'string'
            ? { author: man.author.replace(/\s*<[^>]*>/, '') }
            : man.author?.name ? { author: String(man.author.name) } : {}),
          ...(homeUrl ? { homepage: homeUrl } : {}),
          ...(repoUrl ? { repository: { url: repoUrl } } : {}),
          metadata: {
            keywords: (man.keywords || []).slice(0, 8),
            category,
            ...(record?.stars || record?.downloads || publishTs
              ? {
                sortKeys: {
                  ...(record?.stars ? { stars: record.stars } : {}),
                  ...(record?.downloads ? { downloads: record.downloads } : {}),
                  // Lets DSH sort by recency natively instead of only on our site.
                  ...(publishTs ? { updated: publishTs } : {}),
                },
              }
              : {}),
            labels: displayLabels([
              ...(provenance.get(name)?.origins ?? ['src-npm']),
              ...(provenance.get(name)?.trust ?? []),
              `zh-${zh.source}`,
              ...tierLabels(record?.stars, record?.downloads, true),
            ]),
          },
          versions: [{
            version,
            publishTimestamp: publishTs,
            source: { type: 'npm' },
            engines: { dsh: man.engines.dsh },
          }],
          _sidecar: {
            distIntegrity: man.dist?.integrity,
            attestations: man.dist?.attestations?.url ?? null,
            unpackedSize: man.dist?.unpackedSize ?? null,
            zhSource: zh.source,
            stars: record?.stars ?? null,
            origins: [...(provenance.get(name)?.origins ?? ['src-npm'])],
            trust: [...(provenance.get(name)?.trust ?? [])],
            ...(zh.pinnedFor ? { zhPinnedFor: zh.pinnedFor } : {}),
            gates: ['bundle', 'engines.dsh', 'min-age', 'no-install-script', 'license', 'category', 'zh'],
          },
        })
      } catch (err) {
        reason(rejections, name, 'packument-fetch-failed', String(err.message || err))
      }
    }))
  }

  // 3b. shard mode: hand the verified slice to the merge job and stop. The merge
  //     job unions every shard's part file with the carried catalogue and emits
  //     the published index, so a shard never writes the index itself.
  if (PART_OUT) {
    await mkdir(dirname(PART_OUT), { recursive: true })
    await writeFile(PART_OUT, JSON.stringify({ shard: SHARD, plugins }, null, 0) + '\n')
    console.log(`shard ${SHARD}/${SHARDS}: ${plugins.length} verified -> ${PART_OUT}`)
    return
  }

  // 4. merge this run into the carried catalogue, then shape the document.
  //    Verification is incremental (a cursor walks the pool), so the published
  //    index must be cumulative — otherwise every run would only publish the
  //    slice it happened to check and the catalogue would shrink.
  const cachePath = join(root, 'data', 'catalog.json')
  let cache = { entries: {} }
  try {
    cache = JSON.parse(await readFile(cachePath, 'utf8'))
    if (!cache?.entries) cache = { entries: {} }
  } catch {
    cache = { entries: {} }
  }
  const verifiedAt = Date.now()
  for (const { _sidecar, ...plugin } of plugins) {
    cache.entries[plugin.name] = { plugin, sidecar: _sidecar, verifiedAt }
  }
  const carried = Object.values(cache.entries)
    .sort((a, b) => (b.verifiedAt ?? 0) - (a.verifiedAt ?? 0) || a.plugin.name.localeCompare(b.plugin.name))
  // Re-derive the category at publish time: the taxonomy changes faster than
  // entries are re-verified, and a cached entry must not keep a dead category.
  const textOf = (value) => (typeof value === 'string' ? value : (value?.en ?? ''))
  const kept = carried.slice(0, MAX_PLUGINS).map((entry) => {
    const plugin = entry.plugin
    // Always re-derive: taxonomy v2 changed the leaf ids, so a cached v1 id would
    // keep an entry in a bucket that no longer means the same thing.
    const category = categoryFor(provenance.get(plugin.name), plugin.name, textOf(plugin.title), textOf(plugin.description), (plugin.metadata?.keywords ?? []).join(' '))
    // Stars and weekly downloads come from the catalogs that publish them; the
    // federated discovery covers the whole pool every run, so cached entries get
    // them too.
    const stars = plugin.metadata?.sortKeys?.stars ?? entry.sidecar?.stars ?? provenance.get(plugin.name)?.stars ?? undefined
    const downloads = plugin.metadata?.sortKeys?.downloads ?? entry.sidecar?.downloads ?? provenance.get(plugin.name)?.downloads ?? undefined
    const sortKeys = { ...(plugin.metadata?.sortKeys ?? {}) }
    if (!Number.isFinite(sortKeys.stars) && Number.isFinite(stars) && stars > 0) sortKeys.stars = stars
    if (!Number.isFinite(sortKeys.downloads) && Number.isFinite(downloads) && downloads > 0) sortKeys.downloads = downloads
    const metadata = { ...plugin.metadata, category, labels: displayLabels(plugin.metadata?.labels) }
    if (Object.keys(sortKeys).length) metadata.sortKeys = sortKeys
    else delete metadata.sortKeys
    return { ...plugin, metadata, _sidecar: entry.sidecar }
  })
  // The index order is what a reader sees first (and what DSH's "default order"
  // shows), so publish it sorted by stars rather than alphabetically.
  kept.sort((a, b) => {
    const sa = a.metadata?.sortKeys?.stars ?? 0
    const sb = b.metadata?.sortKeys?.stars ?? 0
    return sb - sa || a.name.localeCompare(b.name)
  })

  // 4b. completeness: every catalog entry we could not re-verify this run is
  //     still published, slim, exactly as the catalog describes it. That is why
  //     the index has ~10k entries on day one instead of after dozens of rounds.
  const slimEntries = []
  if (MERGE_EXTERNAL) {
    for (const record of federated.values()) {
      if (cache.entries[record.name]) continue
      // A commit-pinned git entry is installable without an npm version.
      if (!record.hintVersion && !record.gitSource) continue
      const gitSource = record.gitSource
      const titleEn = record.title?.en || record.name
      const descEn = String(record.description?.en ?? '').trim().slice(0, 160) || titleEn
      const descZh = String(record.description?.zh ?? record.description?.en ?? '').slice(0, 160)
      const labels = displayLabels([
        ...(record.origins ?? []),
        ...(record.trust ?? []),
        ...(record.hintEngines ? [] : ['no-engines']),
        'catalog-only',
        ...tierLabels(record.stars, record.downloads, false),
      ])
      slimEntries.push({
        name: record.name,
        title: { en: titleEn, zh: record.title?.zh || titleEn },
        description: { en: descEn, zh: descZh || descEn },
        ...(record.hintIcon ? { icon: record.hintIcon } : {}),
        // Keep the repository: the enrich step turns it into stars, and a reader
        // needs somewhere to look at the source.
        ...(/^https?:\/\//i.test(String(record.hintRepo ?? '')) ? { repository: { url: String(record.hintRepo).replace(/\.git$/, '') } } : {}),
        metadata: {
          category: categoryFor(record, record.name, titleEn, descEn),
          labels,
          ...(record.stars || record.downloads || record.hintPublishTimestamp
            ? {
              sortKeys: {
                ...(record.stars ? { stars: record.stars } : {}),
                ...(record.downloads ? { downloads: record.downloads } : {}),
                ...(record.hintPublishTimestamp ? { updated: record.hintPublishTimestamp } : {}),
              },
            }
            : {}),
        },
        versions: [{
          // A git-only entry has no npm version; use a valid SemVer placeholder and
          // keep the pinned commit in `source.commit`, which is what identifies the
          // code that gets installed.
          version: record.hintVersion || '0.0.0',
          publishTimestamp: record.hintPublishTimestamp ?? 0,
          // npm-404 entries get a commit-pinned git source, so they really install.
          source: gitSource ?? { type: 'npm' },
          ...(record.hintEngines ? { engines: { dsh: record.hintEngines } } : {}),
        }],
      })
    }
    slimEntries.sort((a, b) => (b.metadata?.sortKeys?.stars ?? 0) - (a.metadata?.sortKeys?.stars ?? 0) || a.name.localeCompare(b.name))
  }
  // Last line of defence: any source (npm registry, catalogues, GitHub monorepos,
  // 2BingLing) can hand us a name the format-1 validator rejects. Filter once here,
  // on the assembled list, so no single adapter can fail the whole crawl at the
  // validate step after 40 minutes of work.
  const VALID_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
  const allEntries = [...kept, ...slimEntries]
  const rejectedNames = allEntries.filter((plugin) => !VALID_NAME.test(String(plugin?.name ?? '')) || String(plugin.name).length > 214)
  const published = allEntries.filter((plugin) => VALID_NAME.test(String(plugin?.name ?? '')) && String(plugin.name).length <= 214).slice(0, MAX_TOTAL)
  if (rejectedNames.length) console.log(`rejected ${rejectedNames.length} invalid npm name(s): ${rejectedNames.slice(0, 5).map((p) => p.name).join(', ')}`)
  console.log(`published: ${published.length} (verified ${kept.length} + catalog-only ${Math.min(slimEntries.length, Math.max(0, MAX_TOTAL - kept.length))})`)

  const sidecar = {
    generatedAt: new Date().toISOString(),
    registry: REGISTRY,
    dshRuntime: DSH_RUNTIME,
    catalogue: {
      carried: carried.length,
      verifiedThisRun: plugins.length,
      catalogOnly: Math.min(slimEntries.length, Math.max(0, MAX_TOTAL - kept.length)),
      published: published.length,
    },
    gates: { minAgeDays: MIN_AGE_DAYS, maxPlugins: MAX_PLUGINS, maxTotal: MAX_TOTAL, requires: ['dsh.bundle.patch', 'engines.dsh satisfied', 'no install script', 'clear license', 'declared category', 'bilingual text'] },
    plugins: published.map((p) => ({ name: p.name, version: p.versions[0].version, category: p.metadata.category, ...(p._sidecar ?? {}) })),
  }
  const index = {
    format: 1,
    title: { en: 'DSH Plugin Index (auto-crawled)', zh: 'DSH 插件索引（自动爬取）' },
    description: {
      en: 'DeepSeekRuntime plugin index, built with DSH: packages that declare a DSH bundle and a satisfied engines.dsh range. Metadata only; the package decides what it installs.',
      zh: '由 DSH 制作的 DeepSeekRuntime 插件索引：只收录声明了 DSH bundle 且 engines.dsh 满足当前运行时的包。这里只有元数据，装什么以包为准。',
    },
    metadata: {
      categories: Object.fromEntries(Object.entries(CATEGORIES).map(([id, t]) => [id, { title: t }])),
      // Only the labels a reader acts on are declared and shown. Everything else
      // ("auto-crawled", "engines-pinned", the zh-source variants) was noise on
      // every card, so it is neither published nor declared any more.
      labels: {
        'src-npm': { title: { en: 'npm', zh: 'npm' } },
        'src-dshso': { title: { en: 'dsh.so', zh: 'dsh.so' } },
        'src-awesome': { title: { en: 'awesome', zh: 'awesome' } },
        'src-mydsh': { title: { en: 'mydsh', zh: 'mydsh' } },
        'src-polang': { title: { en: 'open market', zh: '开放市场' } },
        'src-official': { title: { en: 'Awesome DSH Plugin', zh: '官方精选' } },
        'src-github': { title: { en: 'GitHub', zh: 'GitHub' } },
        'src-2bingling': { title: { en: 'dsh.market', zh: 'dsh.market' } },
        'trust-readme-verified': { title: { en: 'README checked', zh: 'README 核对' } },
        'trust-repo-fallback': { title: { en: 'repo pinned', zh: '仓库固定' } },
        'zh-fallback': { title: { en: 'Chinese pending', zh: '中文待补' } },
        'catalog-only': { title: { en: 'from catalog', zh: '仅目录收录' } },
        'no-engines': { title: { en: 'no engines.dsh', zh: '未声明版本' } },
        // Popularity tiers, generated from the numbers the catalogs publish.
        'stars-hot': { title: { en: '★ 1k+', zh: '★ 1k+' } },
        'stars-mid': { title: { en: '★ 100+', zh: '★ 100+' } },
        'stars-new': { title: { en: '★ <100', zh: '★ <100' } },
        'dl-hot': { title: { en: '1k+ weekly installs', zh: '周下载 1k+' } },
        'dl-mid': { title: { en: '100+ weekly installs', zh: '周下载 100+' } },
        'install-verified': { title: { en: 'install verified', zh: '已通过安装验证' } },
      },
      // Star counts are carried from the catalogs that publish them, so "sort by
      // stars" in DSH works on this index instead of only on dsh.so's own.
      sortKeys: {
        stars: { title: { en: 'Stars', zh: '星标' }, order: 'desc' },
        downloads: { title: { en: 'Weekly downloads', zh: '周下载量' }, order: 'desc' },
        // Newest first by publish time: this is what the site already offers and
        // what DSH otherwise cannot sort by.
        updated: { title: { en: 'Recently updated', zh: '最近更新' }, order: 'desc' },
      },
    },
    plugins: published.map(({ _sidecar, ...rest }) => ({ ...rest })),
  }

  // The hourly translate job writes into data/i18n-cache.json. Replaying it here is
  // what keeps those strings after this run rebuilds the index from shard parts;
  // without it every crawl silently reset translation coverage to ~5%.
  await applyTranslations(index.plugins)

  // The domestic/international split documents were retired: a reader picks a
  // language document instead (crawler/lang-index.mjs), and one link per language
  // is what DSH can actually subscribe to. Generating the old splits cost ~10 MB of
  // JSON per run and nothing read them.
  await mkdir(OUT, { recursive: true })
  const DRY = process.argv.includes('--dry-run')
  if (DRY) {
    console.log(`dry-run: would write ${published.length} plugins (${JSON.stringify(index).length} bytes)`)
  } else {
    await writeFile(join(OUT, 'index.json'), JSON.stringify(index, null, 2) + '\n')
    await writeFile(join(OUT, 'index.sidecar.json'), JSON.stringify(sidecar, null, 2) + '\n')
    await writeFile(join(OUT, 'rejections.json'), JSON.stringify(rejections, null, 2) + '\n')
    // The merge job owns the catalogue and the cursor: a publish-only pass reads
    // both and must not move them, or shard progress would be lost.
    if (!PUBLISH_ONLY) {
      await mkdir(join(root, 'data'), { recursive: true })
      await writeFile(join(root, 'data', 'cursor.json'), JSON.stringify({ offset: nextCursor, pool: pool.length, at: new Date().toISOString() }, null, 2) + '\n')
      const trimmed = { entries: Object.fromEntries(carried.slice(0, 6000).map((entry) => [entry.plugin.name, entry])) }
      await writeFile(cachePath, JSON.stringify(trimmed) + '\n')
    }
  }

  for (const r of rejections) bump(counts, r.why)
  const stats = {
    at: new Date().toISOString(),
    registry: REGISTRY,
    dshRuntime: DSH_RUNTIME,
    queries: QUERIES,
    candidates: names.size,
    shortlisted: shortlist.length,
    kept: kept.length,
    rejected: rejections.length,
    rejectReasons: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])),
    zh: kept.reduce((acc, plugin) => {
      const source = plugin._sidecar.zhSource
      acc[source] = (acc[source] || 0) + 1
      return acc
    }, {}),
    origins: kept.reduce((acc, plugin) => {
      for (const origin of plugin._sidecar.origins ?? []) acc[origin] = (acc[origin] || 0) + 1
      return acc
    }, {}),
    budget: {
      ms: Date.now() - started,
      exhausted: skipped.phase1 > 0 || skipped.phase2 > 0,
      skippedCandidates: skipped.phase1,
      skippedShortlist: skipped.phase2,
    },
    cursor: { from: cursor, to: nextCursor, pool: ordered.length },
    bytes: JSON.stringify(index).length,
    ms: Date.now() - started,
  }
  await writeFile(join(OUT, 'stats.json'), JSON.stringify(stats, null, 2) + '\n')
  console.log(JSON.stringify(stats, null, 2))
}

// ------------------------------------------------------------------ selftest
// The validator rule that matters: never claim compatibility from a range we do
// not understand. Positive and negative cases, so "the check can fail".
function selftest() {
  const cases = [
    ['0.2.1-rc.5', '>=0.2.1-rc.1', true],
    ['0.2.1-rc.5', '^0.2.1-rc.1', true],
    ['0.2.1-rc.5', '0.2.1-rc.5', true],
    ['0.2.1-rc.5', '>=0.3.0', false],
    ['0.2.1-rc.5', '^0.3.0', false],
    ['0.2.1-rc.5', '~0.2.0', true],
    ['0.2.1-rc.5', '>=0.2.0 <0.3.0', true],
    ['0.2.1-rc.5', '0.2.x', true],
    ['0.2.1-rc.5', '*', true],
    ['0.2.1-rc.5', undefined, null],
    ['0.2.1-rc.5', 'workspace:*', null],
    ['0.2.1-rc.5', 'npm:other@1.0.0', null],
    ['0.2.1-rc.5', '>=0.1.0-rc.6', true],
    ['0.2.1-rc.5', '^0.2.0-rc.2', true],
  ]
  let pass = 0
  for (const [version, range, expected] of cases) {
    const actual = satisfies(version, range)
    if (actual !== expected) {
      console.error(`FAIL satisfies(${version}, ${JSON.stringify(range)}) => ${actual}, expected ${expected}`)
    } else pass++
  }
  const ok = pass === cases.length
  console.log(`${ok ? 'PASS' : 'FAIL'} ${pass}/${cases.length} satisfies cases`)
  return ok
}

if (process.argv.includes('--selftest')) {
  process.exit(selftest() ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})