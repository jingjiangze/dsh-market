// Domain library, generated from the WHOLE index instead of a hand-written list.
//
// A hand-written list of 18 needs covered a fraction of a 13,854-row catalogue. The catalogue
// already carries a maintained taxonomy (`metadata.category`, 31 leaves), so a domain is a
// category: nothing is invented, and adding a leaf on the site automatically adds a domain.
//
// Every candidate is verified as far as can be done without installing it:
//   1. it is a row of the format-1 index,
//   2. the install-facts document does not mark it not-installable,
//   3. its engines.dsh admits the runtime the domains are generated for,
//   4. it is not a 0.0.0 placeholder version.
// `--smoke N` goes further and actually installs the top N per domain into a THROWAWAY profile
// (`dsh plugin --profile <tmp>` under a temporary DSH_HOME), records what activated, and marks
// those rows `tier: "smoke"`. It is off by default because it costs seconds per package.
//
// Output is one small document — a reader that does not want domains pays nothing:
//   site/plugin-domains.json   dist/plugin-domains.json
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = [join(root, 'dist', 'index.json'), join(root, 'site', 'index.zh.json')].find((p) => existsSync(p))
if (!INDEX) {
  console.error('plugin-domains: no index found')
  process.exit(1)
}

const FACTS = [join(root, 'site', 'plugin-index.json'), join(root, 'dist', 'plugin-index.json')].find((p) => existsSync(p))
const TAGS = [join(root, 'site', 'plugin-tags.json'), join(root, 'dist', 'plugin-tags.json')].find((p) => existsSync(p))
const OUT = [join(root, 'dist', 'plugin-domains.json'), join(root, 'site', 'plugin-domains.json')]

const RUNTIME = process.env.PLUGIN_DOMAINS_RUNTIME || '0.2.2-rc.1'
const PER_DOMAIN = Number(process.env.PLUGIN_DOMAINS_PER || 5)
const SMOKE = Number(process.env.PLUGIN_DOMAINS_SMOKE || 0)

// Category label → what a user would call the need. A category with no label falls back to its
// slug, so a new leaf still produces a usable domain instead of disappearing.
const LABELS = {
  'enhance-session': '会话增强（导出 / 总结 / 回顾）',
  'enhance-models': '模型与推理增强',
  'ops-security': '安全与运维加固',
  'enhance-memory': '记忆、知识与上下文',
  'enhance-ui': '界面增强',
  'enhance-usage': '用量、配额与成本',
  'connect-web': '网页访问与浏览器自动化',
  'agent-skills': '技能与提示词包',
  'media-vision': '图像与视觉',
  'enhance-tools': '工具增强',
  'data-office': '办公与文档（表格 / PPT / Word）',
  'dev-git': '代码、Git 与评审',
  'data-search': '检索与搜索',
  'data-docs': '文档处理与转换（PDF / Markdown）',
  'connect-mcp': 'MCP 工具连接',
  'agent-orchestration': '多智能体编排',
  other: '其他',
  'media-voice': '语音（TTS / STT / 朗读）',
  'connect-im': '即时通讯与通知',
  'ops-monitor': '监控与日志',
  'dev-runtime': '运行时与部署',
  'connect-remote': '远程访问',
  'data-analysis': '数据分析与可视化',
  'eco-market': '市场与索引',
  'media-fun': '娱乐与彩蛋',
  'agent-workflow': '工作流与自动化',
  'connect-files': '文件与存储',
  'connect-wsl': 'WSL 与子系统',
  'enhance-settings': '设置增强',
  'eco-resources': '资源站点',
  'enhance-perf': '性能优化',
}

// Inlined semver subset (same rules as plugins/dsh-lazy-plugins/lib/compat.mjs): prerelease
// ordering, OR ranges, and npm's `-0` upper bound.
const parse = (text) => {
  const match = String(text ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!match) return null
  return { major: +match[1], minor: +match[2], patch: +match[3], pre: match[4] ? match[4].split('.') : [] }
}
const compare = (a, b) => {
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return 0
  for (const key of ['major', 'minor', 'patch']) if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  if (!left.pre.length && !right.pre.length) return 0
  if (!left.pre.length) return 1
  if (!right.pre.length) return -1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const l = left.pre[i]
    const r = right.pre[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = Number(l)
    const rn = Number(r)
    if (Number.isFinite(ln) && Number.isFinite(rn)) { if (ln !== rn) return ln < rn ? -1 : 1; continue }
    if (Number.isFinite(ln)) return -1
    if (Number.isFinite(rn)) return 1
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}
const satisfiesOne = (version, comparator) => {
  const match = comparator.match(/^(>=|<=|>|<|=)\s*(.+)$/)
  if (!match) return compare(version, comparator) === 0
  const order = compare(version, match[2].trim())
  return match[1] === '>=' ? order >= 0 : match[1] === '<=' ? order <= 0 : match[1] === '>' ? order > 0 : match[1] === '<' ? order < 0 : order === 0
}
const satisfiesEngines = (version, range) => {
  if (!range || !parse(version)) return true
  const ok = String(range).split('||').some((group) => {
    const parts = group.trim().split(/\s+/).filter(Boolean)
    return !parts.length || parts.every((part) => satisfiesOne(version, part))
  })
  if (!ok) return false
  const upper = String(range).match(/<\s*(\d+\.\d+\.\d+)-0/)
  if (!upper) return true
  return compare(version, `${upper[1]}-0`) < 0
}

const readJson = async (path, fallback) => {
  if (!path) return fallback
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

const index = await readJson(INDEX, { plugins: [] })
const facts = await readJson(FACTS, null)
const tags = await readJson(TAGS, { tags: {} })

const installableOf = (name) => {
  if (!facts) return undefined
  if (facts.format === 'dsh-plugin-install-facts') {
    if ((facts.notInstallable ?? []).includes(name)) return false
    if ((facts.unverified ?? []).includes(name)) return undefined
    return true
  }
  return facts.plugins?.find?.((row) => row.name === name)?.installable
}

const filters = { notInstallable: 0, engines: 0, placeholder: 0, noCategory: 0 }
const byCategory = new Map()

for (const plugin of index.plugins ?? []) {
  const name = String(plugin.name ?? '')
  const version = plugin.versions?.[0] ?? {}
  const category = plugin.metadata?.category
  if (!name) continue
  if (!category) { filters.noCategory += 1; continue }
  if (installableOf(name) === false) { filters.notInstallable += 1; continue }
  if (version.engines?.dsh && !satisfiesEngines(RUNTIME, version.engines.dsh)) { filters.engines += 1; continue }
  if (String(version.version ?? '').startsWith('0.0.0')) { filters.placeholder += 1; continue }
  const list = byCategory.get(category) ?? []
  list.push({
    name,
    version: version.version,
    source: version.source?.type,
    engines: version.engines?.dsh,
    tags: (tags.tags?.[name] ?? []).slice(0, 4),
    title: String(plugin.title ?? ''),
    description: String(plugin.description ?? ''),
    curated: Number(plugin.metadata?.sortKeys?.curated ?? 0),
    trust: Number(plugin.metadata?.sortKeys?.trust ?? 0),
    labels: Array.isArray(plugin.metadata?.labels) ? plugin.metadata.labels : [],
  })
  byCategory.set(category, list)
}

const domains = []
for (const [category, rows] of [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length)) {
  // Prefer rows with community tags (a sign they are catalogued elsewhere too), then the
  // shorter name — "dsh-tts" is a capability, "dsh-video-length-checker" is a detail — then
  // alphabetical, so the output is stable between runs.
  // Rank by the catalogue's own curation. A row the crawl marked install-verified comes
  // first, then the curated score, then trust; community tags and name length only break ties.
  for (const row of rows) {
    row.verified = row.labels.includes('install-verified')
    row.declaresEngines = row.labels.includes('declares-engines')
  }
  rows.sort((a, b) =>
    (Number(b.verified) - Number(a.verified))
    || (b.curated - a.curated)
    || (b.trust - a.trust)
    || (b.tags.length - a.tags.length)
    || (a.name.length - b.name.length)
    || a.name.localeCompare(b.name))

  domains.push({
    id: category,
    zh: LABELS[category] ?? category,
    total: rows.length,
    candidates: rows.filter((row) => row.verified || row.curated >= 60).slice(0, PER_DOMAIN).map((row) => ({
      name: row.name,
      version: row.version,
      source: row.source,
      engines: row.engines,
      tags: row.tags,
      tier: row.verified ? 'facts+install-verified' : 'facts',
      curated: row.curated,
      trust: row.trust,
    })),
  })
}

// Optional real-install pass. Kept out of the default path: it shells out to pnpm for every
// package and writes into a throwaway profile, so only CI should enable it.
if (SMOKE > 0) {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const home = mkdtempSync(join(tmpdir(), 'dsh-domains-smoke-'))
  const profile = join(home, 'profiles', 'smoke')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'smoke', private: true, dsh: { profile: { bundles: [] } } }, null, 2))
  let done = 0
  for (const domain of domains) {
    for (const candidate of domain.candidates.slice(0, SMOKE)) {
      try {
        execFileSync('dsh', ['plugin', '--profile', profile, 'add', `${candidate.name}@${candidate.version}`], {
          env: { ...process.env, DSH_HOME: home },
          stdio: 'pipe',
          timeout: 120000,
        })
        candidate.tier = 'smoke'
        done += 1
      } catch (error) {
        candidate.tier = 'smoke-failed'
        candidate.smokeError = String(error?.message ?? error).slice(0, 200)
      }
    }
  }
  console.log(`plugin-domains: smoke installed ${done} packages into ${profile}`)
}

const document = {
  format: 'dsh-plugin-domains',
  schema: 2,
  generatedAt: new Date().toISOString(),
  runtime: RUNTIME,
  method: 'domain = the index category (no hand-written list); candidate = index row + install-facts installable + engines.dsh admits runtime + not a 0.0.0 placeholder; ordered by the catalogue\'s own curation (install-verified, curated, trust)',
  filters,
  count: domains.length,
  domains,
}
const text = JSON.stringify(document)
for (const path of OUT) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text + '\n')
}
console.log(
  `plugin-domains: ${domains.length} domains, ${domains.reduce((s, d) => s + d.candidates.length, 0)} candidates, ${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`,
)
console.log('filters:', JSON.stringify(filters))
