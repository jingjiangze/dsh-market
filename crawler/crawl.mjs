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
import { discoverFederated } from './sources.mjs'
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
const MAX_PLUGINS = Number(process.env.MAX_PLUGINS || 1500)
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES || 4000)
const CONCURRENCY = Number(process.env.CONCURRENCY || 16)
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
const CATEGORIES = {
  safety: { en: 'Safety & Auditing', zh: '安全与审计' },
  memory: { en: 'Memory & Knowledge', zh: '记忆与知识' },
  models: { en: 'Models & Providers', zh: '模型与供应商' },
  automation: { en: 'Automation & Teams', zh: '自动化与协作' },
  devtools: { en: 'Developer Tools', zh: '开发者工具' },
  integrations: { en: 'Integrations & Sharing', zh: '集成与分享' },
  media: { en: 'Media & Vision', zh: '媒体与视觉' },
  ui: { en: 'UI & Themes', zh: '界面与主题' },
  other: { en: 'Other', zh: '其他' },
}

const CATEGORY_RULES = [
  ['safety', /\b(audit|security|secret|guard|quarantine|permission|sandbox|vet|policy|confirm)\b/],
  ['ui', /\b(theme|themes|skin|appearance|wallpaper|background|layout|sidebar|panel|badge|font|pet|meme|catppuccin|prts)\b|界面|主题|壁纸/],
  ['media', /\b(image|images|video|tts|voice|audio|screenshot|vision|chart|charts|canvas|blender|music|pdf|office|docx|xlsx|cad|poster|genui)\b/],
  ['integrations', /\b(feishu|lark|qq|telegram|discord|wechat|slack|gateway|remote|tailscale|lan|sync|share|mcp|bridge)\b/],
  ['memory', /\b(memory|knowledge|rag|recall|embedding|sqlite|obsidian|deepread|context|skill|skills|prompt|chapter|chapters|archive|dream|custom-mode)\b/],
  ['models', /\b(provider|providers|model|models|llm|api-key|openai|anthropic|qoder|codex|cline|subscription|usage|billing|cost|token|tokens)\b/],
  ['automation', /\b(automation|scheduled|schedule|cron|workflow|agent-team|agent-teams|multi-agent|swarm|orchestrator|ralph|kanban|goal|checkpoint|rewind)\b/],
  ['devtools', /\b(worktree|git|terminal|shell|lint|diff|debug|ide|editor|typescript|cli|search|index)\b/],
]

function classify(...texts) {
  const haystack = texts.filter(Boolean).join(' ').toLowerCase()
  for (const [id, pattern] of CATEGORY_RULES) if (pattern.test(haystack)) return id
  return 'other'
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
  for (const record of federated.values()) {
    names.add(record.name)
    const entry = provenance.get(record.name) ?? { origins: new Set(), trust: new Set() }
    for (const origin of record.origins) entry.origins.add(origin)
    for (const trust of record.trust) entry.trust.add(trust)
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
  const candidates = ordered.slice(0, MAX_CANDIDATES)

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
        const category = classify(name, enTitle, enDescription, (man.keywords || []).join(' '))
        plugins.push({
          name,
          title: { en: enTitle, zh: zh.title || enTitle },
          description: { en: enDescription, zh: zh.description || enDescription },
          ...(iconPath ? { icon: `https://cdn.jsdelivr.net/npm/${name}@${version}/${iconPath}` } : {}),
          ...(typeof man.author === 'string'
            ? { author: man.author.replace(/\s*<[^>]*>/, '') }
            : man.author?.name ? { author: String(man.author.name) } : {}),
          ...(man.homepage ? { homepage: man.homepage } : {}),
          ...(man.repository?.url ? { repository: { url: String(man.repository.url).replace(/^git\+/, '').replace(/\.git$/, '') } } : {}),
          metadata: {
            keywords: (man.keywords || []).slice(0, 8),
            category,
            labels: ['auto-crawled', 'engines-pinned', `zh-${zh.source}`, ...(provenance.get(name)?.origins ?? ['src-npm']), ...(provenance.get(name)?.trust ?? [])],
          },
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
            zhSource: zh.source,
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

  // 4. shape the document
  const kept = plugins
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_PLUGINS)

  const sidecar = {
    generatedAt: new Date().toISOString(),
    registry: REGISTRY,
    dshRuntime: DSH_RUNTIME,
    gates: { minAgeDays: MIN_AGE_DAYS, maxPlugins: MAX_PLUGINS, requires: ['dsh.bundle.patch', 'engines.dsh satisfied', 'no install script', 'clear license', 'declared category', 'bilingual text'] },
    plugins: kept.map((p) => ({ name: p.name, version: p.versions[0].version, category: p.metadata.category, ...p._sidecar })),
  }
  const index = {
    format: 1,
    title: { en: 'DSH Plugin Index (auto-crawled)', zh: 'DSH 插件索引（自动爬取）' },
    description: {
      en: 'Crawled from the public npm registry: packages that declare a DSH bundle and a satisfied engines.dsh range. Bilingual titles and descriptions come from each package\'s own locale files where it ships them. Metadata only; the package decides what it installs.',
      zh: '从公共 npm 源自动爬取：只收录声明了 DSH bundle 且 engines.dsh 满足当前运行时的包。中英双语标题与简介优先取包自带 locale 文件，没有则用人工整理的覆盖表。这里只有元数据，装什么以包为准。',
    },
    metadata: {
      categories: Object.fromEntries(Object.entries(CATEGORIES).map(([id, t]) => [id, { title: t }])),
      labels: {
        'auto-crawled': { title: { en: 'Auto-crawled', zh: '自动爬取' } },
        'engines-pinned': { title: { en: 'engines.dsh pinned', zh: '已钉 DSH 版本' } },
        'zh-native': { title: { en: 'Chinese text from the package', zh: '中文取自包自带 locale' } },
        'zh-override': { title: { en: 'Chinese text curated here', zh: '中文由本仓库整理' } },
        'zh-detected': { title: { en: 'Chinese text written by the author', zh: '中文为作者原文' } },
        'zh-fallback': { title: { en: 'Chinese text pending', zh: '中文待补（暂用英文）' } },
        'zh-catalog': { title: { en: 'Chinese text from a federated catalog', zh: '中文取自联邦目录' } },
        'src-npm': { title: { en: 'Found on npm search', zh: 'npm 检索收录' } },
        'src-dshso': { title: { en: 'Listed by dsh.so', zh: 'dsh.so 目录收录' } },
        'src-awesome': { title: { en: 'Listed by awesome-dsh-plugin', zh: 'awesome-dsh-plugin 收录' } },
        'src-mydsh': { title: { en: 'Listed by mydsh.xyz', zh: 'mydsh.xyz 收录' } },
        'trust-readme-verified': { title: { en: 'Source checked it against its README', zh: '来源按其 README 核对过' } },
        'trust-repo-fallback': { title: { en: 'Source pinned it by repository commit', zh: '来源按仓库提交固定' } },
        'trust-unpinned': { title: { en: 'Source gave no pinned target', zh: '来源未给固定安装目标' } },
        'trust-source-index': { title: { en: 'Listed in another market index', zh: '收录于其他市场索引' } },
      },
    },
    plugins: kept.map(({ _sidecar, ...rest }) => ({ ...rest })),
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
    zh: kept.reduce((acc, plugin) => {
      const source = plugin._sidecar.zhSource
      acc[source] = (acc[source] || 0) + 1
      return acc
    }, {}),
    origins: kept.reduce((acc, plugin) => {
      for (const origin of plugin._sidecar.origins ?? []) acc[origin] = (acc[origin] || 0) + 1
      return acc
    }, {}),
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