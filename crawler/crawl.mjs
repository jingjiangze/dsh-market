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
import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, 'dist')

const REGISTRY = (process.env.NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '')
// Keyword search only works on the npm registry proper: npmmirror ignores the
// `keywords:` prefix and answers 0, so discovery stays on npmjs by default.
const SEARCH_REGISTRY = (process.env.SEARCH_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '')
const DSH_RUNTIME = process.env.DSH_RUNTIME_VERSION || '0.2.1-rc.5'
const MIN_AGE_DAYS = Number(process.env.MIN_AGE_DAYS || 3)
const MAX_PLUGINS = Number(process.env.MAX_PLUGINS || 200)
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES || 160)
const CONCURRENCY = Number(process.env.CONCURRENCY || 8)
const QUERIES = (process.env.SEARCH_QUERIES || [
  'keywords:dsh-plugin',
  'keywords:deepseek-harness',
  'keywords:dsh',
].join(',')).split(',')

const UA = 'dsh-market-crawler/1.0 (+https://github.com/jingjiangze/dsh-market)'

// ---------------------------------------------------------------- utilities
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJSON(url, { accept = 'application/json', tries = 3 } = {}) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { accept, 'user-agent': UA },
        signal: AbortSignal.timeout(20000),
      })
      if (res.status === 404) return { notFound: true }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return { body: await res.json() }
    } catch (err) {
      last = err
      if (i < tries - 1) await sleep(500 * (i + 1))
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
  if (!text || text === '*' || text === 'latest') return null
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
  const rejections = []
  const counts = new Map()

  // 1. candidate discovery
  const names = new Set()
  for (const q of QUERIES) {
    try {
      for (const n of await search(q)) names.add(n)
    } catch (err) {
      reason(rejections, `<query ${q}>`, 'search-failed', String(err.message || err))
    }
  }
  const candidates = [...names].sort().slice(0, MAX_CANDIDATES)
  console.log(`candidates: ${names.size} (capped to ${candidates.length})`)

  // 2. phase 1: cheap latest-manifest gate
  const shortlist = []
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
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
  for (let i = 0; i < shortlist.length; i += CONCURRENCY) {
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
        plugins.push({
          name,
          ...(meta.title ? { title: localized(String(meta.title)) } : {}),
          ...(man.description ? { description: localized(String(man.description).slice(0, 280)) } : {}),
          ...(iconPath ? { icon: `https://cdn.jsdelivr.net/npm/${name}@${version}/${iconPath}` } : {}),
          ...(typeof man.author === 'string'
            ? { author: man.author.replace(/\s*<[^>]*>/, '') }
            : man.author?.name ? { author: String(man.author.name) } : {}),
          ...(man.homepage ? { homepage: man.homepage } : {}),
          ...(man.repository?.url ? { repository: { url: String(man.repository.url).replace(/^git\+/, '').replace(/\.git$/, '') } } : {}),
          metadata: { keywords: (man.keywords || []).slice(0, 8) },
          versions: [{
            version,
            publishTimestamp: Math.floor(Date.parse(pack.time[version]) / 1000),
            source: { type: 'npm' },
            engines: { dsh: man.engines.dsh },
          }],
          _sidecar: {
            distIntegrity: man.dist?.integrity,
            attestations: man.dist?.attestations?.url ?? null,
            unpackedSize: man.dist?.unpackedSize ?? null,
            gates: ['bundle', 'engines.dsh', 'min-age', 'no-install-script', 'license'],
          },
        })
      } catch (err) {
        reason(rejections, name, 'packument-fetch-failed', String(err.message || err))
      }
    }))
  }

  // 4. shape the document
  const kept = plugins
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_PLUGINS)

  const sidecar = {
    generatedAt: new Date().toISOString(),
    registry: REGISTRY,
    dshRuntime: DSH_RUNTIME,
    gates: { minAgeDays: MIN_AGE_DAYS, maxPlugins: MAX_PLUGINS, requires: ['dsh.bundle.patch', 'engines.dsh satisfied', 'no install script', 'clear license'] },
    plugins: kept.map((p) => ({ name: p.name, version: p.versions[0].version, ...p._sidecar })),
  }
  const index = {
    format: 1,
    title: { en: 'DSH Plugin Index (auto-crawled)', zh: 'DSH 插件索引（自动爬取）' },
    description: {
      en: 'Crawled from the public npm registry: packages that declare a DSH bundle and a satisfied engines.dsh range. Metadata only; the package decides what it installs.',
      zh: '从公共 npm 源自动爬取：只收录声明了 DSH bundle 且 engines.dsh 满足当前运行时的包。这里只有元数据，装什么以包为准。',
    },
    metadata: {
      categories: { plugins: { title: { en: 'Plugins', zh: '插件' } } },
      labels: {
        'auto-crawled': { title: { en: 'Auto-crawled', zh: '自动爬取' } },
        'engines-pinned': { title: { en: 'engines.dsh pinned', zh: '已钉 DSH 版本' } },
      },
    },
    plugins: kept.map(({ _sidecar, ...rest }) => ({
      ...rest,
      metadata: { ...rest.metadata, category: 'plugins', labels: ['auto-crawled', 'engines-pinned'] },
    })),
  }

  await mkdir(OUT, { recursive: true })
  const DRY = process.argv.includes('--dry-run')
  if (DRY) {
    console.log(`dry-run: would write ${kept.length} plugins (${JSON.stringify(index).length} bytes)`)
  } else {
    await writeFile(join(OUT, 'index.json'), JSON.stringify(index, null, 2) + '\n')
    await writeFile(join(OUT, 'index.sidecar.json'), JSON.stringify(sidecar, null, 2) + '\n')
    await writeFile(join(OUT, 'rejections.json'), JSON.stringify(rejections, null, 2) + '\n')
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
    ['0.2.1-rc.5', '*', null],
    ['0.2.1-rc.5', undefined, null],
    ['0.2.1-rc.5', 'workspace:*', null],
    ['0.2.1-rc.5', 'npm:other@1.0.0', null],
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