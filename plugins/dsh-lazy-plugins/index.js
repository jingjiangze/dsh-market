/**
 * On-demand plugin loading — v2.0.0.
 *
 * Loads a plugin from the configured market index only when a task needs it, activates
 * it live, and releases it afterwards. Talks only to supported services:
 *   pluginMarket.search/entry                — the index the profile already subscribes to
 *   pluginManager.installBundle / setBundleEnabled / removeBundle
 *
 * Borrowed behaviour and its sources are listed in CREDITS.md. In short:
 *   dsh-mcp-summon        — dormant by default, summon to register, release to reclaim
 *   dsh-hotswap           — reload a running plugin without restarting dsh
 *   dsh-skill-mcp-manager — in-session hot reload
 *   dsh-tool-manager      — optional deferred tool schema (deferLoading)
 *   dsh-plugin / @ace-zone/dsh-market / dsh-open-market — installed-state reading
 *
 * There is deliberately no telemetry and no reporting: nothing leaves the machine.
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs'
import { mkdir, appendFile, readFile, rename, rm, readdir, lstat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { compareVersions, satisfiesEngines } from './lib/compat.mjs'
import { collapse, expandTerms, sameFamily, termsOf } from './lib/ranking.mjs'
import { buildIndex as buildBm25Index, search as bm25Search } from './lib/bm25.mjs'
import { rrfFuse } from './lib/fusion.mjs'
import { cosine, createEncoder } from './lib/embed.mjs'

export const inject = ['tools']

export const name = 'dsh-lazy-plugins'

// Reported by `list` so a live instance can be told apart from a stale one after an
// upgrade (a linked bundle is re-imported only when the row restarts).
const VERSION = '3.90.0'

// The id the client half registers under, and the key `clientModules.graph()` uses for
// this package's browser row (`@local/dsh-lazy-plugins` + `exports['./client']`).
const SELF_PACKAGE = '@local/dsh-lazy-plugins'

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

// A tool result must be lossless JSON: no undefined members, no NaN/Infinity. Market
// entries legitimately have holes (no default version, no installed version, no
// category), so every return value is cleaned instead of being hand-trimmed.
const clean = (value) => {
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      if (typeof item === 'number' && !Number.isFinite(item)) continue
      if (typeof item === 'function') continue
      out[key] = clean(item)
    }
    return out
  }
  return value
}

const titleOf = (entry) => {
  const title = entry?.title
  if (!title) return undefined
  if (typeof title === 'string') return title
  return title.zh ?? title.en ?? Object.values(title)[0]
}

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i

// The index renames duplicate packages (`dsh-foo` -> `dsh-foo-2`, `@scope/dsh-foo` ->
// `@scope/dsh-foo-2`) but keeps the published name in `title`. When that title is itself
// a valid npm name, it is the real install target, so it is offered as a second candidate
// and only used once the registry proves it exists.
const aliasNamesOf = (entry) => {
  const title = typeof entry?.title === 'string' ? entry.title : titleOf(entry)
  if (!title || title === entry?.name) return []
  return NPM_NAME.test(title) ? [title] : []
}

const summarize = (entry) => ({
  name: entry.name,
  title: titleOf(entry),
  version: entry.defaultVersion ?? entry.versions?.[0]?.version,
  installed: entry.installation?.status ?? 'unknown',
  installedVersion: entry.installation?.installedVersion,
  category: entry.metadata?.category,
  score: entry.metadata?.sortKeys?.score,
  source: entry.versions?.[0]?.source?.type ?? entry.source,
  registry: entry.versions?.[0]?.source?.registry,
  description: typeof entry.description === 'string' ? entry.description : textOfLocalized(entry.description),
  descriptionSource: entry.descriptionSource,
})

const textOfLocalized = (value) => {
  if (!value) return undefined
  if (typeof value === 'string') return value
  return value.zh ?? value.en ?? Object.values(value)[0]
}

// Settings page: build a schemastery schema from the profile's own copy of the package.
// Failure is non-fatal — without it there is simply no generated page.
let configError
const buildConfigSchema = () => {
  try {
    const root = join(homedir(), '.dsh', 'profiles')
    for (const entry of readdirSync(root)) {
      const manifest = join(root, entry, 'package.json')
      if (!existsSync(manifest)) continue
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
      if (!Object.keys(parsed?.dependencies ?? {}).some((name) => name.startsWith('@local/dsh-lazy-plugins'))) continue
      const req = createRequire(manifest)
      const loaded = req('@deepseek-ai/schemastery')
      const z = loaded?.default ?? loaded
      if (typeof z?.object !== 'function') continue
      return z.object({
        defaultActivate: z.union([z.const('proxy'), z.const('now'), z.const('session')]).default('proxy').description('load 的默认激活方式：proxy 隐藏工具保持提示词缓存 / now 立即可见 / session 仅安装'),
        autoSelectEnabled: z.boolean().default(true).description('ensure 是否允许自动安装（关闭后只给候选）'),
        autoSelectScore: z.number().default(40).description('自动安装所需的分数下限'),
        autoSelectMargin: z.number().default(1.5).description('自动安装所需的领先倍数'),
        verifyInstall: z.boolean().default(true).description('安装前是否探测 registry（站点索引可用时自动跳过）'),
        prefetch: z.boolean().default(true).description('是否预取候选包的 tarball（命中后安装走 file:）'),
        prefetchLimit: z.number().default(2).description('suggest 时预取前 N 个候选'),
        strictUsable: z.boolean().default(false).description('安装后若未观察到工具/技能则回滚（默认关闭：事件型与挂件型插件看不见）'),
        bridgeWeight: z.number().default(0.4).description('中英双语桥接词权重'),
        categoryBoost: z.number().default(0.3).description('同分类软加权（0 关闭）'),
        setupRiskPenalty: z.number().default(0.6).description('描述含“需额度/需打开页面”等成本时的分数系数'),
        indexUrl: z.string().description('市场索引地址（留空用 profile 里配置的那个）'),
        gitMirrors: z.array(z.string()).description('git 源的归档镜像模板，按 {owner}/{repo}/{sha} 占位'),
        refreshIntervalMs: z.number().default(180000).description('索引后台复核间隔（ms）'),
        cacheTtlMs: z.number().default(86400000).description('索引最长可服务时长（ms）'),
        resident: z.array(z.string()).description('强制常驻的包名'),
        residentScore: z.number().default(3).description('按使用分自动常驻的阈值'),
        halfLifeDays: z.number().default(14).description('使用分半衰期（天）'),
        deferLoading: z.boolean().default(false).description('把本工具也标记为延迟加载'),
        inspectMs: z.number().default(2500).description('装前检查超时（ms）'),
      })
    }
  } catch (error) {
    configError = String(error?.message ?? error)
  }
  return undefined
}

export const Config = buildConfigSchema()

const DEFAULTS = {
  // Serving a cached index is the default; this is the longest a copy is ever served
  // without a successful refresh in between (7 days).
  cacheTtlMs: 604800000,
  // A copy older than this is refreshed in the background while the caller keeps using it.
  // Short on purpose: a conditional request against the primary source answers 304 in
  // ~0.6 s with no body, so keeping the cache current is nearly free.
  refreshIntervalMs: 180000,
  // One attempt, not the whole chain: the budget covers time-to-first-byte only. Measured:
  // the primary source answers in ~0.5 s TTFB / 1.43 s total, jsDelivr 0.50 s TTFB but
  // 1.49-3.92 s total, so a 5 s cap on the whole body would abort a healthy mirror.
  fetchTimeoutMs: 3000,
  bodyTimeoutMs: 20000,
  maxBytes: 67108864,
  // Verified mirrors, in order. `raw.githubusercontent.com` is unreachable from this host
  // (two 30 s timeouts) and gcore.jsdelivr took 8.2 s, so neither is listed. The repo has
  // no gh-pages branch: the published path is `@main/site/`, not `@gh-pages/`.
  indexMirrors: [
    'https://cdn.jsdelivr.net/gh/jingjiangze/dsh-market@main/site/index.zh.json',
  ],
  deferLoading: false,
  // Packages that are common or foundational: they are still fetched on demand the first
  // time, but once present they are never unloaded or removed by accident, and a disabled
  // one is switched back on when this plugin activates.
  // Residency: protection for base bundles is structural, "used often" is computed from
  // local counters with this half-life and threshold (no telemetry, no network).
  // `resident` stays available as an explicit override on top of the computed set.
  resident: [],
  halfLifeDays: 14,
  // Used when the profile registers no market index at all.
  indexUrlFallback: 'https://jingjiangze.github.io/dsh-market/index.zh.json',
  // Auto-update policy: off | pool (only packages this tool installed).
  autoUpdate: 'pool',
  autoUpdateMax: 3,
  // Ceiling for a single term's weight (see idfOf).
  idfCap: 4,
  // Judgement by the session model instead of a word list.
  judgeMode: 'llm',
  judgeCandidates: 12,
  judgeMinConfidence: 0.7,
  // When the caller reports a failed attempt, acting beats stalling: accept a lower confidence.
  judgeMinConfidenceOnFailure: 0.55,
  // How many already-bound tools ride along in the same judge call.
  judgeInstalledCandidates: 6,
  // First recall engine: 'select' (model queries + BM25) or 'lexical'.
  recall: 'select',
  // Second retrieval pass: let the model rewrite the need into short queries first.
  rewritePass: 'on',
  rewriteMaxQueries: 3,
  rewriteMaxTokens: 400,
  judgeTimeoutMs: 15000,
  judgeMaxTokens: 800,
  // A cached verdict avoids the round-trip entirely; the key includes the candidate list.
  judgeCacheDays: 7,
  judgeDescriptionChars: 100,
  judgeReasoningEffort: 'low',
  residentScore: 3,
  // How a plain load activates. 'proxy' (default) = usable at once, tools hidden from the
  // model and run through action=invoke, so the visible tool set never changes;
  // 'now' = tools appear natively (one prompt-prefix rebuild); 'session' = install only.
  defaultActivate: 'proxy',
  // Auto-selection guards: an absolute score floor plus a margin over the runner-up. Both
  // must pass, otherwise the caller gets the candidate list instead of an install.
  autoSelectScore: 40,
  // Calibrated on a 30-need corpus: at 1.3 the auto-install precision was 0.636; 1.5 lifts
  // it to 0.80 while recall drops to 0.167 — the floor turned out to be inert.
  autoSelectMargin: 1.5,
  // Off by default: it raises recall (0.167 -> ~0.6) but the measured precision drops from
  // 0.80 to ~0.72-0.77, so the caller opts in rather than getting it silently.
  autoSelectFamilyExempt: false,
  // Soft category boost: candidates sharing the top pick's category get +30% before the
  // decisive test. Measured: same precision (0.80), coverage 0.167 -> 0.333. Set 0 to disable.
  categoryBoost: 0.3,
  // Weight of a bridged (translated) term relative to a term the user actually wrote.
  bridgeWeight: 0.4,
  // Score factor for candidates whose description admits a setup cost (account, open page).
  setupRiskPenalty: 0.6,
  // Prefetch the tarball of the leading candidates while the caller is still choosing, then
  // install from the local file: fewer network round-trips inside the blocking install.
  prefetch: true,
  // Secondary community catalog: stars/downloads/verified as a tiebreak and trust marker.
  catalogSources: [
    'https://raw.githubusercontent.com/losebird/dsh-plugin-market/main/registry/all.json',
  ],
  catalogTimeoutMs: 30000,
  // A verified domain candidate is a prior, not a winner: lift, never decide.
  domainBoost: 1.12,
  prefetchLimit: 2,
  prefetchTimeoutMs: 20000,
  // Pre-flight budget for pluginManager.inspect (its own default is 20 s, too slow here).
  inspectMs: 2500,
  // How long to wait for the client module graph before calling an install empty.
  clientGraphWaitMs: 500,
  // Off by default: rolling back an install because no tool/skill appeared deletes working
  // event- and widget-style plugins. Enable to get the old aggressive behaviour.
  strictUsable: false,
  // Git-sourced entries: the harness aborts a git install when its own probe to github.com
  // takes more than 5 s, so the archive is fetched from mirrors instead (fastest wins).
  // Time to first byte per mirror; the winner's body is then downloaded without a race.
  archiveProbeMs: 8000,
  archiveMaxBytes: 134217728,
  gitMirrors: [
    'https://codeload.github.com/{owner}/{repo}/tar.gz/{sha}',
    'https://ghproxy.net/https://github.com/{owner}/{repo}/archive/{sha}.tar.gz',
    'https://ghfast.top/https://github.com/{owner}/{repo}/archive/{sha}.tar.gz',
  ],
  autoSelectEnabled: true,
  // Background index refresh triggers: at start, daily as a floor, and at most once a
  // minute when a panel asks for it.
  // A boot enable issued in the same tick as this row's activation fails with
  // operation-error (the manager is still reconciling), so the boot work is delayed.
  bootDelayMs: 1200,
  dailyRefreshMs: 86400000,
  panelThrottleMs: 60000,
  // Pre-flight check: a large share of the public index names packages that no npm
  // registry serves, and a failing pnpm resolve costs tens of seconds. Probe first.
  verifyInstall: true,
  // The published DSH document dropped per-plugin descriptions (2026-11-06 crawl), so a
  // candidate arrives as name + title + category only. Filling the top rows from the
  // registry costs one request each (~80-150 ms in parallel) and is what the model needs
  // to pick the package whose功能 really matches.
  enrichDescriptions: true,
  enrichTimeoutMs: 2000,
  // Mirror first: measured 41 ms here against >900 ms for npmjs.org.
  enrichRegistries: ['https://registry.npmmirror.com', 'https://registry.npmjs.org'],
  enrichCacheTtlMs: 3600000,
  // The repository copy of the site document still carries per-plugin descriptions
  // (10,991 of 10,995), while the Pages copy no longer does. One CDN fetch (~840 KB gzip,
  // 12 h TTL) builds a name -> description map, which makes description search and row
  // enrichment local instead of one registry request per candidate.
  // Sidecar first (10,577 zh descriptions, 1.46 MB raw / 608 KB gzip, PR #27), then the
  // repository document that still carries descriptions, then give up and use the registry.
  descriptionSources: [
    'https://jingjiangze.github.io/dsh-market/descriptions.zh.json',
    'https://cdn.jsdelivr.net/gh/jingjiangze/dsh-market@main/site/descriptions.zh.json',
    'https://cdn.jsdelivr.net/gh/jingjiangze/dsh-market@main/site/index.zh.json',
  ],
  descriptionTtlMs: 43200000,
  descriptionSearch: true,
  // Hybrid recall: fuse BM25 ranks with the local encoder once its matrix is on disk. Audited
  // 2026-11-10 on 2,000 judged needs: bm25 R@1 11.05% / embedding 9.60% / fused 13.40%,
  // R@20 30.80% / 30.25% / 34.25%. Fusion reorders rows BM25 already matched, never widens.
  fusionSearch: true,
  probeTimeoutMs: 6000,
  // First-phase probe budget against the declared registry only: a hit answers in tens of
  // milliseconds, a miss costs at most this before the wider sweep starts.
  probeFastMs: 400,
  registryFallbacks: ['https://registry.npmjs.org', 'https://registry.npmmirror.com'],
  // Keep a copy of the index between processes: the memory cache alone refetches the
  // ~2.2 MB (gzip) document on every dsh start.
  diskCache: true,
}

const REGISTRY_DEFAULT = 'https://registry.npmjs.org'

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config }

  const manager = () => ctx.get('pluginManager')
  const market = () => ctx.get('pluginMarket')

  // Names this plugin installed and activated, so `list` can tell them apart from
  // whatever the user installed deliberately.
  const loaded = new Set()
  const indexCache = new Map()
  // URLs with a refresh in flight, so a burst of calls sends one request, not many.
  const refreshing = new Set()
  // Definitive installability verdicts, so a second `load` of the same pin is instant.
  const probeCache = new Map()
  // Market name -> real npm name, for entries the index renamed.
  const installedUnder = new Map()
  const realNameOf = (packageName) => installedUnder.get(packageName) ?? packageName
  // Result of the last resident warm-up, surfaced by `list`.
  let warmed = []
  // Recent action timings. Kept in memory and flushed to the cache directory, so "why was
  // that slow" is answerable from `advise` without any external profiler.
  const timings = []
  let timingsDirty = false
  const timingsPath = () => join(cacheDir(), 'timings.json')

  const recordTiming = (action, ms, extra) => {
    timings.push({ action, ms, at: Date.now(), ...(extra ?? {}) })
    if (timings.length > 300) timings.splice(0, timings.length - 300)
    timingsDirty = true
  }

  const loadTimings = async () => {
    if (timings.length) return
    try {
      const parsed = JSON.parse(await readFile(timingsPath(), 'utf8'))
      if (Array.isArray(parsed?.rows)) timings.push(...parsed.rows.slice(-300))
    } catch {
      // first run
    }
  }

  const flushTimings = async () => {
    if (!timingsDirty) return
    timingsDirty = false
    try {
      await mkdir(cacheDir(), { recursive: true })
      await writeFile(timingsPath(), JSON.stringify({ rows: timings.slice(-300) }))
    } catch {
      // the panel is advisory
    }
  }

  const percentile = (values, fraction) => {
    if (!values.length) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))))
    return sorted[index]
  }

  const perfSummary = () => {
    const byAction = new Map()
    for (const row of timings) {
      const list = byAction.get(row.action) ?? []
      list.push(row.ms)
      byAction.set(row.action, list)
    }
    const actions = [...byAction.entries()]
      .map(([action, values]) => ({
        action,
        n: values.length,
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        max: Math.max(...values),
      }))
      .sort((a, b) => b.p95 - a.p95)
    const slowest = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 5)
    return { sample: timings.length, actions, slowest }
  }
  let disposeSettings
  let disposePrompt
  let promptSectionRegistered = false
  // Result of the last engines audit. Filled at boot and whenever `verify` runs, so
  // `advise` can report a runtime mismatch without the model having to ask first.
  let runtimeHealth = { checkedAt: 0, runtime: undefined, incompatible: [], verdict: 'unknown' }
  // Background installs: requestId -> in-flight promise; finished results wait for `wait`.
  const backgroundJobs = new Map()

  // Start a load without waiting for it; `wait` collects the outcome by requestId.
  const startBackgroundLoad = (name, extra) => {
    const requestId = String(extra?.requestId ?? `lazy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    const job = load({ ...extra, name, background: false, requestId })
      .then((value) => ({ requestId, done: true, result: value }))
      .catch((error) => ({ requestId, done: true, error: String(error?.message ?? error) }))
    backgroundJobs.set(requestId, job)
    return requestId
  }
  // Skill registration handle + error, hoisted so advise can report them.
  let disposeSkill
  let skillError

  // Cache telemetry, exposed by `list` so a low hit rate is visible instead of guessed.
  const stats = {
    searches: 0,
    indexMemoryHits: 0,
    indexDiskHits: 0,
    indexNetwork: 0,
    indexNotModified: 0,
    descriptionMapLoads: 0,
    descriptionMapHits: 0,
    packumentFetches: 0,
  }

  const pickIndexUrl = () => {
    const api = market()
    const indexes = api?.listIndexes?.() ?? []
    if (config.indexUrl) {
      const wanted = indexes.find((item) => item.url === config.indexUrl)
      if (wanted) return wanted.url
      // Configured but not registered with the market service: still usable directly.
      return config.indexUrl
    }
    const registered = indexes[0]?.url
    if (registered) return registered
    // Last resort: the catalogue this plugin is built against. Without it a profile whose
    // `plugin-market.indexes` is empty would make every action return "no index".
    return DEFAULTS.indexUrlFallback
  }

  const requireMarket = () => {
    const api = market()
    if (!api) throw new Error('pluginMarket is unavailable; configure a market index in this profile first')
    const url = pickIndexUrl()
    if (!url) throw new Error('no market index URL is configured in this profile')
    return { api, url }
  }

  const requireManager = () => {
    const api = manager()
    if (!api) throw new Error('pluginManager is unavailable in this profile')
    return api
  }

  // Index fetch policy, in the order the user asked for it:
  //   1. every attempt is bounded (5 s by default), a lapsed attempt moves to the next
  //      source instead of hanging on one;
  //   2. sources are the profile's index first, then the mirrors;
  //   3. a copy on disk is preferred over the network — it is read, served immediately,
  //      and refreshed in the background, so it also covers a dead network;
  //   4. the refresh keeps the cache current (conditional request, atomic replace), so a
  //      newly published index shows up without a restart.
  const cacheDir = () => join(process.env.DSH_CACHE_DIR ?? join(homedir(), '.dsh', 'cache'), 'dsh-lazy-plugins')

  const diskPathOf = (url) => join(cacheDir(), `${createHash('sha1').update(url).digest('hex')}.json`)

  const readDisk = async (url) => {
    if (!settings.diskCache) return null
    try {
      const parsed = JSON.parse(await readFile(diskPathOf(url), 'utf8'))
      return parsed?.url === url && parsed?.document ? parsed : null
    } catch {
      return null
    }
  }

  // Write to a sibling file and rename it: a crash mid-write then leaves the previous
  // cache intact instead of a truncated JSON document.
  const writeDisk = async (url, entry) => {
    if (!settings.diskCache) return
    try {
      await mkdir(cacheDir(), { recursive: true })
      const path = diskPathOf(url)
      const temporary = `${path}.${Date.now()}.tmp`
      await writeFile(temporary, JSON.stringify({ url, ...entry }))
      await rename(temporary, path)
    } catch {
      // A cache write must never turn a successful read into a failure.
    }
  }

  const fetchFrom = async (source, conditional, timeoutMs) => {
    const controller = new AbortController()
    const headMs = Number(timeoutMs) || Number(settings.fetchTimeoutMs) || DEFAULTS.fetchTimeoutMs
    const bodyMs = Number(settings.bodyTimeoutMs) || DEFAULTS.bodyTimeoutMs
    let headTimer = setTimeout(() => controller.abort(), headMs)
    let bodyTimer
    try {
      const headers = { accept: 'application/json', 'accept-encoding': 'gzip, deflate, br' }
      if (conditional?.etag) headers['if-none-match'] = conditional.etag
      if (conditional?.lastModified) headers['if-modified-since'] = conditional.lastModified
      const response = await fetch(source, { headers, signal: controller.signal })
      // Headers arrived: the 5 s budget was for the wait, not for a 0.9 MB body.
      clearTimeout(headTimer)
      headTimer = null
      if (response.status === 304) return { notModified: true, source }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      // dsh.jiangjiangze.icu is an SPA that answers unknown paths with 200 + HTML, so a
      // bare `response.ok` check would parse a web page as the index.
      const type = String(response.headers.get('content-type') ?? '')
      if (!/json/i.test(type)) throw new Error(`unexpected content-type: ${type || '(none)'}`)
      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > (Number(settings.maxBytes) || DEFAULTS.maxBytes)) {
        throw new Error(`refusing ${declared} bytes`)
      }
      bodyTimer = setTimeout(() => controller.abort(), bodyMs)
      const body = await response.text()
      const document = JSON.parse(body)
      if (!Array.isArray(document?.plugins)) throw new Error('not an index document')
      return {
        document,
        etag: response.headers.get('etag') ?? undefined,
        lastModified: response.headers.get('last-modified') ?? undefined,
        source,
      }
    } finally {
      if (headTimer) clearTimeout(headTimer)
      if (bodyTimer) clearTimeout(bodyTimer)
    }
  }

  const sourcesFor = (url) => [url, ...(settings.indexMirrors ?? [])].filter(
    (value, index, all) => value && all.indexOf(value) === index,
  )

  const fetchChain = async (url, conditional) => {
    const failures = []
    const sources = sourcesFor(url)
    for (const source of sources) {
      try {
        // A conditional request only makes sense against the source it came from.
        const useConditional = conditional && (conditional.source === source || !conditional.source) ? conditional : undefined
        return await fetchFrom(source, useConditional)
      } catch (error) {
        failures.push({ source, error: error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error) })
      }
    }
    const error = new Error(`cannot read the index from any source: ${failures.map((item) => `${item.source} (${item.error})`).join('; ')}`)
    error.failures = failures
    throw error
  }

  const storeIndex = async (url, entry) => {
    indexCache.set(url, entry)
    await writeDisk(url, entry)
  }

  // Never blocks a caller and never throws: a failed refresh leaves the served copy alone.
  const revalidate = (url, current) => {
    if (refreshing.has(url)) return
    refreshing.add(url)
    const conditional = current?.etag || current?.lastModified
      ? { etag: current.etag, lastModified: current.lastModified, source: current.source }
      : undefined
    stats.indexNetwork += 1
    void fetchChain(url, conditional)
      .then(async (result) => {
        if (result.notModified) stats.indexNotModified += 1
        const next = result.notModified
          ? { ...current, at: Date.now(), checkedAt: Date.now() }
          : { at: Date.now(), checkedAt: Date.now(), document: result.document, etag: result.etag, lastModified: result.lastModified, source: result.source }
        await storeIndex(url, next)
      })
      .catch(() => {})
      .finally(() => refreshing.delete(url))
  }

  // Fields the tool actually reads from a row. Everything else is dropped by the slim cache.
  const SLIM_FIELDS = ['name', 'title', 'description', 'versions', 'metadata']

  const slimOf = (document) => ({
    generatedAt: document?.generatedAt,
    plugins: (document?.plugins ?? []).map((plugin) => ({
      name: plugin.name,
      title: plugin.title,
      description: plugin.description,
      metadata: plugin.metadata ? { category: plugin.metadata.category, labels: plugin.metadata.labels, sortKeys: plugin.metadata.sortKeys } : undefined,
      versions: (plugin.versions ?? []).slice(0, 1).map((version) => ({
        version: version.version,
        publishTimestamp: version.publishTimestamp,
        source: version.source ? { type: version.source.type, url: version.source.url, commit: version.source.commit, registry: version.source.registry } : undefined,
        engines: version.engines,
      })),
    })),
  })

  const slimPathOf = (url) => join(cacheDir(), `${createHash('sha1').update('slim:' + url).digest('hex')}.json.gz`)

  const readSlim = async (url) => {
    try {
      const { gunzipSync } = await import('node:zlib')
      const buffer = await readFile(slimPathOf(url))
      return JSON.parse(gunzipSync(buffer).toString('utf8'))
    } catch {
      return undefined
    }
  }

  const writeSlim = async (url, document) => {
    try {
      const { gzipSync } = await import('node:zlib')
      await mkdir(cacheDir(), { recursive: true })
      await writeFile(slimPathOf(url), gzipSync(Buffer.from(JSON.stringify(slimOf(document)))))
    } catch {
      // the slim copy is an optimisation
    }
  }

  const readIndex = async (url) => {
    const memory = indexCache.get(url)
    if (!memory) {
      // A slim copy loads in a fraction of the time and is enough for every read path.
      const slim = await readSlim(url)
      if (slim?.plugins?.length) {
        indexCache.set(url, { at: Date.now(), checkedAt: Date.now(), document: slim })
        stats.indexDiskHits += 1
        return slim
      }
    }
    if (memory && Date.now() - memory.at < settings.cacheTtlMs) {
      stats.indexMemoryHits += 1
      if (Date.now() - (memory.checkedAt ?? memory.at) > settings.refreshIntervalMs) revalidate(url, memory)
      return memory.document
    }
    const onDisk = settings.diskCache ? await readDisk(url) : null
    if (onDisk && Date.now() - onDisk.at < settings.cacheTtlMs) {
      stats.indexDiskHits += 1
      if (Date.now() - (onDisk.checkedAt ?? onDisk.at) > settings.refreshIntervalMs) revalidate(url, onDisk)
      indexCache.set(url, onDisk)
      // Build the slim copy from a full-document disk hit too: otherwise it is only written
      // after a fresh network fetch, which a 304 revalidation never does.
      void writeSlim(url, onDisk.document)
      return onDisk.document
    }
    try {
      stats.indexNetwork += 1
      const result = await fetchChain(url, onDisk ? { etag: onDisk.etag, lastModified: onDisk.lastModified } : undefined)
      if (result.notModified) stats.indexNotModified += 1
      if (result.notModified && onDisk?.document) {
        const touched = { ...onDisk, at: Date.now(), checkedAt: Date.now() }
        await storeIndex(url, touched)
        return touched.document
      }
      const entry = {
        at: Date.now(),
        checkedAt: Date.now(),
        document: result.document,
        etag: result.etag,
        lastModified: result.lastModified,
        source: result.source,
      }
      await storeIndex(url, entry)
      void writeSlim(url, entry.document)
      return entry.document
    } catch (error) {
      if (onDisk?.document) {
        indexCache.set(url, onDisk)
        return onDisk.document
      }
      throw error
    }
  }

  // ---- site-published install facts ---------------------------------------------
  // The crawler publishes a DIFF document (format 'dsh-plugin-install-facts'):
  //   notInstallable[] / unverified[]; a name absent from both is installable from the source
  //   the format-1 index states. That is 41 KB, against 5.9 MB for the older full document,
  //   which is still accepted here so both deployments work.
  const factsPath = () => join(cacheDir(), 'install-facts.json')
  let installFacts
  let factsBuilding

  const siteIndexUrlOf = (indexUrl) => {
    try {
      const url = new URL(indexUrl)
      url.pathname = url.pathname.replace(/\/index\.[a-z]{2}\.json$/i, '/plugin-index.json')
      return url.toString()
    } catch {
      return null
    }
  }

  const buildInstallFacts = async (sourceUrl) => {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(Number(settings.bodyTimeoutMs) || DEFAULTS.bodyTimeoutMs) })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const document = await response.json()
    const payload = { at: Date.now(), source: sourceUrl }
    if (document?.format === 'dsh-plugin-install-facts') {
      payload.mode = 'diff'
      payload.generatedAt = document.generatedAt
      payload.count = document.count
      payload.notInstallable = (document.notInstallable ?? []).map(String)
      payload.unverified = (document.unverified ?? []).map(String)
      // Engines are not repeated here on purpose: the format-1 index carries them.
    } else if (document?.format === 'dsh-plugin-index' || Array.isArray(document?.plugins)) {
      payload.mode = 'full'
      payload.generatedAt = document.generatedAt
      payload.count = document.count
      const map = {}
      for (const row of document.plugins ?? []) {
        if (!row?.name) continue
        map[row.name] = { installable: row.installable === true, version: row.version, engines: row.engines, source: row.source?.type }
      }
      payload.map = map
    } else {
      throw new Error('unexpected format: ' + String(document?.format))
    }
    try {
      await mkdir(cacheDir(), { recursive: true })
      await writeFile(factsPath(), JSON.stringify(payload))
    } catch {
      // disk cache is an optimisation
    }
    return payload
  }

  const refreshInstallFacts = (indexUrl) => {
    if (factsBuilding) return factsBuilding
    const source = siteIndexUrlOf(indexUrl)
    if (!source) return undefined
    factsBuilding = buildInstallFacts(source)
      .then((payload) => {
        installFacts = payload
        return payload
      })
      .catch(() => undefined)
      .finally(() => {
        factsBuilding = undefined
      })
    return factsBuilding
  }

  // Non-blocking, like every other catalogue: a stale copy is served while a refresh runs.
  const installFactsOf = async (indexUrl) => {
    if (installFacts) {
      if (Date.now() - (installFacts.at ?? 0) > 43200000) void refreshInstallFacts(indexUrl)
      return installFacts
    }
    try {
      const cached = JSON.parse(readFileSync(factsPath(), 'utf8'))
      if (cached?.mode) {
        installFacts = cached
        if (Date.now() - (cached.at ?? 0) > 43200000) void refreshInstallFacts(indexUrl)
        return installFacts
      }
    } catch {
      // no copy yet
    }
    void refreshInstallFacts(indexUrl)
    return undefined
  }

  // true / false / undefined, from whichever document shape is deployed.
  const installableOf = (facts, name) => {
    if (!facts) return undefined
    if (facts.mode === 'full') {
      const row = facts.map?.[name]
      return row ? row.installable : undefined
    }
    if ((facts.notInstallable ?? []).includes(name)) return false
    if ((facts.unverified ?? []).includes(name)) return undefined
    return true
  }

  // engines come from the format-1 index we already load for search.
  const enginesOf = async (name, url) => {
    try {
      const document = await readIndex(url)
      const plugin = (document.plugins ?? []).find((row) => row.name === name)
      return plugin?.versions?.[0]?.engines?.dsh
    } catch {
      return undefined
    }
  }

  // ---- model judgement ----------------------------------------------------------
  // Ask the session model to pick from a shortlist. Returns undefined when no model is
  // reachable or the answer cannot be parsed, so every caller keeps its lexical path.
  const judgeCachePath = () => join(cacheDir(), 'judge-cache.json')
  const judgeCache = new Map()

  const judgeKeyOf = (need, list) => createHash('sha1')
    .update(String(need).toLowerCase().trim() + '\u0000' + list.map((row) => row.name).join(','))
    .digest('hex')

  // Training corpus for the "tiny selector" plan: one JSON line per judged decision.
  const trainingPath = () => join(cacheDir(), 'judge-training.jsonl')
  const appendTrainingSample = async (sample) => {
    try {
      const line = JSON.stringify(sample) + '\n'
      await mkdir(cacheDir(), { recursive: true })
      await appendFile(trainingPath(), line, 'utf8')
    } catch {
      // a lost sample is not worth failing a decision over
    }
  }

  const readJudgeCache = async () => {
    if (judgeCache.size) return judgeCache
    try {
      const parsed = JSON.parse(await readFile(judgeCachePath(), 'utf8'))
      for (const [key, value] of Object.entries(parsed ?? {})) judgeCache.set(key, value)
    } catch {
      // no cache yet
    }
    return judgeCache
  }

  const writeJudgeCache = async () => {
    try {
      await mkdir(cacheDir(), { recursive: true })
      const entries = [...judgeCache.entries()].slice(-200)
      await writeFile(judgeCachePath(), JSON.stringify(Object.fromEntries(entries)))
    } catch {
      // the cache is an optimisation
    }
  }

  // "Turn one sentence into short retrieval queries." Cached with the judge cache.
  const rewriteQueries = async (need, failure) => {
    const llm = ctx.get('llm')
    if (!llm?.stream) return undefined
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (!selection?.provider || !selection?.model) return undefined
    await readJudgeCache()
    const key = 'q:' + createHash('sha1').update(String(need).toLowerCase().trim()).digest('hex')
    const cached = judgeCache.get(key)
    if (cached && Date.now() - (cached.at ?? 0) < (Number(settings.judgeCacheDays) || DEFAULTS.judgeCacheDays) * 86400000) {
      return { ...cached.result, cached: true }
    }
    const system = [
      'Rewrite one user request into short search queries over a plugin catalogue.',
      'Answer with JSON only: {"queries": ["...", "...", "..."]}',
      'Rules: 3-4 queries; each 2-6 words; use both Chinese and English terms when the request mixes them;',
      'name the capability, the object and the tool type, never how the user feels; no duplicates.',
    ].join(' ')
    const prompt = `Request: ${String(need).slice(0, 400)}${failure ? `\nWhat already failed: ${String(failure).slice(0, 200)}` : ''}`
    try {
      let text = ''
      for (const maxTokens of [Number(settings.rewriteMaxTokens) || DEFAULTS.rewriteMaxTokens, 800]) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), Number(settings.judgeTimeoutMs) || DEFAULTS.judgeTimeoutMs)
        try {
          for await (const chunk of llm.stream({
            provider: selection.provider,
            model: selection.model,
            system,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            maxTokens,
            temperature: 0,
            signal: controller.signal,
            purpose: 'lazy-plugin-rewrite',
          })) {
            if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
            if (chunk?.type === 'finish') break
          }
        } finally {
          clearTimeout(timer)
        }
        if (text.trim()) break
      }
      const json = text.match(/\{[\s\S]*\}/)?.[0]
      if (!json) return { ok: false, reason: text.trim() ? 'unparsable' : 'empty-answer' }
      const answer = JSON.parse(json)
      const queries = (Array.isArray(answer?.queries) ? answer.queries : [])
        .map((q) => String(q ?? '').trim())
        .filter((q) => q.length >= 2)
        .slice(0, Number(settings.rewriteMaxQueries) || DEFAULTS.rewriteMaxQueries)
      const result = { ok: true, queries }
      judgeCache.set(key, { at: Date.now(), result })
      void writeJudgeCache()
      return result
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error).slice(0, 160) }
    }
  }

  const llmJudge = async (need, candidates, options = {}) => {
    const llm = ctx.get('llm')
    if (!llm?.stream) return undefined
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    const provider = selection?.provider
    const model = selection?.model
    if (!provider || !model) return undefined
    const list = candidates.slice(0, Number(settings.judgeCandidates) || DEFAULTS.judgeCandidates)
    if (!list.length) return undefined
    // Same need, same candidates → same question. Skip the model entirely.
    await readJudgeCache()
    const cacheKey = judgeKeyOf(need, list)
    const cached = judgeCache.get(cacheKey)
    const ttl = (Number(settings.judgeCacheDays) || DEFAULTS.judgeCacheDays) * 86400000
    if (cached && Date.now() - (cached.at ?? 0) < ttl) {
      // Cache hits are still real judgements: keep them in the corpus and the shadow baseline.
      void appendTrainingSample({ need, failure: options.failure, candidates: list.map((row) => ({ name: row.name, title: row.title, description: row.description })), pick: cached.result?.pick?.name, confidence: cached.result?.confidence, why: cached.result?.why, model, cached: true, at: new Date().toISOString() })
      return { ...cached.result, cached: true }
    }
    const lines = list.map((row, index) => {
      const description = String(row.description ?? '').replace(/\s+/g, ' ').slice(0, Number(settings.judgeDescriptionChars) || DEFAULTS.judgeDescriptionChars)
      const tags = Array.isArray(row.tags) && row.tags.length ? ` tags=${row.tags.join(',')}` : ''
      return `${index + 1}. ${row.name} | ${String(row.title ?? '').slice(0, 60)} | ${description}${tags}`
    })
    const system = [
      'You choose a plugin for one user request. Answer with JSON only:',
      '{"pick": <1-based number from the list, or null>, "confidence": <0..1>, "why": "<20 words max>"}',
      'Rules: pick only when the plugin genuinely does what the request needs; otherwise pick null.',
      'Do not pick a plugin that merely mentions a word from the request. Never invent a package name.',
      'If the assistant can do the job itself with what it already has (plain writing, translation,',
      'summarising, reasoning, editing code in place), answer {"pick": "none"} instead of naming a plugin.',
      'Answer immediately: no explanation outside the JSON, no reasoning.',
    ].join(' ')
    // A failure is part of the request: 'the repo 404'd' changes which plugin fits.
    const failure = options.failure ? `\n\nWhat already failed: ${String(options.failure).slice(0, 300)}` : ''
    const prompt = `Request: ${String(need).slice(0, 400)}${failure}\n\nCandidates:\n${lines.join('\n')}`
    try {
      // A reasoning model can spend the whole budget before emitting text, which produced an
      // empty answer (measured: 1 of 2 calls). Retry once with more room instead of giving up.
      let text = ''
      const budgets = [Number(settings.judgeMaxTokens) || DEFAULTS.judgeMaxTokens, (Number(settings.judgeMaxTokens) || DEFAULTS.judgeMaxTokens) * 2]
      for (const maxTokens of budgets) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), Number(settings.judgeTimeoutMs) || DEFAULTS.judgeTimeoutMs)
        try {
          for await (const chunk of llm.stream({
            provider,
            model,
            system,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            maxTokens,
            ...(settings.judgeReasoningEffort ? { reasoningEffort: settings.judgeReasoningEffort } : {}),
            temperature: 0,
            signal: controller.signal,
            purpose: 'lazy-plugin-judge',
          })) {
            if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
            if (chunk?.type === 'finish') break
          }
        } finally {
          clearTimeout(timer)
        }
        if (text.trim()) break
      }
      const json = text.match(/\{[\s\S]*\}/)?.[0]
      if (!json) return { ok: false, reason: text.trim() ? 'unparsable' : 'empty-answer', raw: text.slice(0, 300), model }
      const answer = JSON.parse(json)
      if (String(answer?.pick ?? '').toLowerCase() === 'none') {
        const result = { ok: true, none: true, pick: undefined, confidence: Math.max(0, Math.min(1, Number(answer?.confidence) || 0)), why: typeof answer?.why === 'string' ? answer.why.slice(0, 200) : undefined, model, considered: list.length }
        // One sample per verdict: a "none" is training data too (the negative class).
        void appendTrainingSample({
          need,
          failure: options.failure,
          candidates: list.map((row) => ({ name: row.name, title: row.title, description: row.description })),
          pick: null,
          confidence: result.confidence,
          why: result.why,
          model,
          none: true,
          at: new Date().toISOString(),
        })
        judgeCache.set(cacheKey, { at: Date.now(), result })
        void writeJudgeCache()
        return result
      }
      const index = Number(answer?.pick)
      const picked = Number.isFinite(index) && index >= 1 && index <= list.length ? list[index - 1] : undefined
      const result = {
        ok: true,
        pick: picked,
        confidence: Math.max(0, Math.min(1, Number(answer?.confidence) || 0)),
        why: typeof answer?.why === 'string' ? answer.why.slice(0, 200) : undefined,
        model,
        considered: list.length,
        options: options.raw === true ? list : undefined,
      }
      // Cache even a null pick: "nothing here fits" is the most valuable answer to reuse.
      // Every positive verdict is a corpus sample — this line was missing, which is why the
      // training log only ever contained "none" decisions.
      void appendTrainingSample({
        need,
        failure: options.failure,
        candidates: list.map((row) => ({ name: row.name, title: row.title, description: row.description })),
        pick: picked?.name,
        confidence: result.confidence,
        why: result.why,
        model,
        at: new Date().toISOString(),
      })
      judgeCache.set(cacheKey, {
        at: Date.now(),
        result: { ok: true, pick: result.pick, confidence: result.confidence, why: result.why, model, considered: list.length },
      })
      void writeJudgeCache()
      return result
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error).slice(0, 200), model }
    }
  }

  // ---- training corpus (P1) ------------------------------------------------------
  // Lives with the working notes, not in the profile cache: it is training data for review.
  const corpusDir = () => 'C:/DDDD/Agent Work/_tmp/lazy-probe/corpus'
  const corpusPath = (kind) => join(corpusDir(), `${kind}.jsonl`)

  const samplePlugins = (document, count, seed) => {
    const rows = (document?.plugins ?? []).filter((plugin) => plugin?.name)
    if (!rows.length) return []
    // Deterministic spread over the catalogue so a re-run continues instead of repeating.
    const step = Math.max(1, Math.floor(rows.length / Math.max(count, 1)))
    const out = []
    for (let i = 0; i < rows.length && out.length < count; i += step) {
      const row = rows[(i + seed) % rows.length]
      if (row) out.push(row)
    }
    return out
  }

  const askNeedsFor = async (plugin) => {
    const llm = ctx.get('llm')
    if (!llm?.stream) return undefined
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (!selection?.provider || !selection?.model) return undefined
    const title = plainText(plugin.title)
    const description = plainText(plugin.description)
    const system = [
      'You write the user side of a plugin catalogue.',
      'Given one plugin, write 3 short requests a real user would type when they need exactly this.',
      'Answer with JSON only: {"needs": ["...", "...", "..."]}',
      'Rules: 6-20 characters each, natural Chinese, no plugin names, no two that are paraphrases.',
      'Every request must need an external tool, file access or a service the assistant does not have:',
      'name the concrete object (PDF, Excel, 发票, 录音, GitHub, 网页, 二维码) and the operation on it.',
      'Never write a request the assistant could satisfy by writing text alone (translate/rewrite/summarise).',
    ].join(' ')
    const prompt = `Plugin: ${plugin.name}\nTitle: ${title}\nDescription: ${description.slice(0, 200)}`
    try {
      let text = ''
      for (const maxTokens of [300, 600]) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), Number(settings.judgeTimeoutMs) || DEFAULTS.judgeTimeoutMs)
        try {
          for await (const chunk of llm.stream({
            provider: selection.provider,
            model: selection.model,
            system,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
            maxTokens,
            temperature: 0.7,
            signal: controller.signal,
            purpose: 'lazy-plugin-corpus',
          })) {
            if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
            if (chunk?.type === 'finish') break
          }
        } finally {
          clearTimeout(timer)
        }
        if (text.trim()) break
      }
      const json = text.match(/\{[\s\S]*\}/)?.[0]
      if (!json) return undefined
      const answer = JSON.parse(json)
      const needs = (Array.isArray(answer?.needs) ? answer.needs : [])
        .map((need) => String(need ?? '').trim())
        .filter((need) => need.length >= 4 && need.length <= 40)
        .slice(0, 3)
      return needs.length ? needs : undefined
    } catch {
      return undefined
    }
  }

  // One batch: N plugins → 3 needs each (positives) + hard negatives from the same category.
  const corpusStatePath = () => join(corpusDir(), 'state.json')
  const readCorpusState = async () => {
    try { return JSON.parse(await readFile(corpusStatePath(), 'utf8')) } catch { return { offset: 0 } }
  }
  const writeCorpusState = async (state) => {
    try { await mkdir(corpusDir(), { recursive: true }); await writeFile(corpusStatePath(), JSON.stringify(state), 'utf8') } catch {}
  }

  // "none" samples: needs the assistant serves itself. Without them a student ranker learns that
  // every request needs a plugin — the most expensive mistake this domain has.
  const askNoneNeeds = async (count) => {
    const llm = ctx.get('llm')
    if (!llm?.stream) return []
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (!selection?.provider || !selection?.model) return []
    const system = [
      'You write realistic user requests for an AI coding assistant.',
      'All of them must be things the assistant can do itself with no plugin: translating, rewriting,',
      'summarising, explaining code, renaming, small refactors, arithmetic, formatting text.',
      'Answer with JSON only: {"needs": ["...", ...]}',
      'Rules: 6-24 characters each, natural Chinese, no plugin or tool names, no duplicates.',
    ].join(' ')
    try {
      let text = ''
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Number(settings.judgeTimeoutMs) || DEFAULTS.judgeTimeoutMs)
      try {
        for await (const chunk of llm.stream({
          provider: selection.provider,
          model: selection.model,
          system,
          messages: [{ role: 'user', content: [{ type: 'text', text: `Write ${count} such requests.` }] }],
          maxTokens: 600,
          temperature: 0.9,
          signal: controller.signal,
          purpose: 'lazy-plugin-corpus-none',
        })) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          if (chunk?.type === 'finish') break
        }
      } finally {
        clearTimeout(timer)
      }
      const json = text.match(/\{[\s\S]*\}/)?.[0]
      if (!json) return []
      const answer = JSON.parse(json)
      return (Array.isArray(answer?.needs) ? answer.needs : [])
        .map((need) => String(need ?? '').trim())
        .filter((need) => need.length >= 4 && need.length <= 40)
        .slice(0, count)
    } catch {
      return []
    }
  }

  const buildCorpus = async (args = {}) => {
    if (String(args.kind ?? '') === 'none') {
      const want = Math.min(Math.max(Number(args.count) || 40, 1), 400)
      await mkdir(corpusDir(), { recursive: true })
      let written = 0
      let rounds = 0
      while (written < want && rounds < 40) {
        rounds += 1
        const needs = await askNoneNeeds(Math.min(8, want - written))
        if (!needs.length) continue
        const batch = needs.map((need) => ({ kind: 'none', need, correct: null, at: new Date().toISOString() }))
        await appendFile(corpusPath('none'), batch.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8').catch(() => {})
        written += batch.length
      }
      return { kind: 'none', written, file: corpusPath('none') }
    }
    const count = Math.min(Math.max(Number(args.count) || 40, 1), 400)
    const { url } = requireMarket()
    const document = await readIndex(url)
    const state = await readCorpusState()
    const start = Number(args.offset ?? state.offset) || 0
    const picked = samplePlugins(document, count, start)
    await writeCorpusState({ offset: start + count, updatedAt: new Date().toISOString() })
    await mkdir(corpusDir(), { recursive: true })
    const rows = []
    let asked = 0
    for (const plugin of picked) {
      const needs = await askNeedsFor(plugin)
      asked += 1
      if (!needs) continue
      const sameCategory = (document?.plugins ?? [])
        .filter((row) => row.metadata?.category === plugin.metadata?.category && row.name !== plugin.name)
        .slice(0, 4)
        .map((row) => row.name)
      // Append per plugin: a parallel run must show progress and survive an interruption.
      const batch = needs.map((need) => ({ kind: 'positive', need, correct: plugin.name, hardNegatives: sameCategory, at: new Date().toISOString() }))
      rows.push(...batch)
      await appendFile(corpusPath('positives'), batch.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8').catch(() => {})
    }

    return { asked, written: rows.length, file: corpusPath('positives'), plugins: picked.length, nextOffset: start + count }
  }

  // ---- domain library ----------------------------------------------------------
  const domainsPath = () => new URL('./data/domains.json', import.meta.url)
  let domainsCache

  const domainsOf = () => {
    if (domainsCache !== undefined) return domainsCache
    try {
      const parsed = JSON.parse(readFileSync(domainsPath(), 'utf8'))
      domainsCache = Array.isArray(parsed?.domains) ? parsed : { domains: [] }
    } catch {
      domainsCache = { domains: [] }
    }
    return domainsCache
  }

  // Which domain does this need belong to? Token match on the need text, zh labels included.
  const domainMatchOf = (need) => {
    const text = String(need ?? '').toLowerCase()
    if (!text.trim()) return undefined
    let best
    for (const domain of domainsOf().domains ?? []) {
      let hits = 0
      for (const token of domain.tokens ?? []) {
        if (token && text.includes(String(token).toLowerCase())) hits += 1
      }
      for (const piece of String(domain.zh ?? '').split(/[\/、\s]+/)) {
        if (piece && piece.length > 1 && text.includes(piece)) hits += 1
      }
      if (hits && (!best || hits > best.hits)) best = { domain, hits }
    }
    return best?.domain
  }

  const domainNamesOf = (domain) => new Set((domain?.candidates ?? []).map((row) => row.name))

  // ---- community catalog -----------------------------------------------------
  const catalogPath = () => join(cacheDir(), 'catalog.json')
  let catalogMap
  let catalogBuilding

  const catalogSourcesOf = () => (settings.catalogSources ?? DEFAULTS.catalogSources)

  const buildCatalog = async () => {
    const sources = catalogSourcesOf()
    for (const url of sources) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(Number(settings.catalogTimeoutMs) || DEFAULTS.catalogTimeoutMs) })
        if (!response.ok) continue
        const document = await response.json()
        const items = Array.isArray(document?.items) ? document.items : Array.isArray(document) ? document : []
        if (!items.length) continue
        const map = {}
        for (const item of items) {
          const key = item?.package ?? item?.name
          if (!key) continue
          map[String(key)] = {
            stars: Number(item.stars) || 0,
            downloads: Number(item.downloads) || 0,
            verified: item.verified === true,
            kind: item.type,
            category: item.category,
            tags: Array.isArray(item.tags) ? item.tags.slice(0, 8) : undefined,
          }
        }
        const payload = { at: Date.now(), source: url, count: Object.keys(map).length, map }
        try {
          await mkdir(cacheDir(), { recursive: true })
          await writeFile(catalogPath(), JSON.stringify(payload))
        } catch {
          // the disk copy is an optimisation
        }
        return payload
      } catch {
        // try the next source
      }
    }
    return undefined
  }

  const refreshCatalog = () => {
    if (catalogBuilding) return catalogBuilding
    catalogBuilding = buildCatalog()
      .then((payload) => {
        if (payload) catalogMap = payload
        return payload
      })
      .catch(() => undefined)
      .finally(() => {
        catalogBuilding = undefined
      })
    return catalogBuilding
  }

  // Never blocks: a stale copy is served while a refresh runs.
  const catalogOf = async () => {
    if (catalogMap) {
      if (Date.now() - (catalogMap.at ?? 0) > 43200000) void refreshCatalog()
      return catalogMap
    }
    try {
      const cached = JSON.parse(readFileSync(catalogPath(), 'utf8'))
      if (cached?.map) {
        catalogMap = cached
        if (Date.now() - (cached.at ?? 0) > 43200000) void refreshCatalog()
        return catalogMap
      }
    } catch {
      // no copy yet
    }
    void refreshCatalog()
    return undefined
  }

  const tarballPathOf = (packageName, version) => {
    const safe = String(packageName).replace(/[^a-z0-9._-]+/gi, '-')
    return join(cacheDir(), 'pkg', `${safe}-${version}.tgz`)
  }

  // dist metadata per name@version: the tarball URL the registry itself advertises plus its
  // integrity string. Cached for an hour; a miss simply disables the prefetch for that package.
  const distCache = new Map()

  const distOf = async (packageName, version, registries) => {
    const key = `${packageName}@${version}`
    const hit = distCache.get(key)
    if (hit && Date.now() - hit.at < 3600000) return hit.value
    const candidates = (Array.isArray(registries) ? registries : [registries])
      .filter(Boolean)
      .map((item) => String(item).replace(/\/+$/, ''))
    // Fast mirror first: it is the only registry that reliably answers from this host.
    if (!candidates.includes('https://registry.npmmirror.com')) candidates.unshift('https://registry.npmmirror.com')
    for (const base of candidates) {
      try {
        const response = await fetch(`${base}/${String(packageName).replace('/', '%2f')}`, {
          headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
          signal: AbortSignal.timeout(4000),
        })
        if (!response.ok) continue
        const document = await response.json()
        const dist = document?.versions?.[version]?.dist
        if (!dist?.tarball) continue
        // The tarball URL must point at the registry that answered, or a mirror copy would
        // send us back to npmjs.
        const tarball = String(dist.tarball).replace(/^https?:\/\/registry\.npmjs\.org/, base)
        const value = { tarball, integrity: dist.integrity, shasum: dist.shasum, registry: base }
        distCache.set(key, { value, at: Date.now() })
        return value
      } catch {
        // try the next registry
      }
    }
    distCache.set(key, { value: undefined, at: Date.now() })
    return undefined
  }

  // Downloads one package tarball into the cache (idempotent, integrity-checked). Failures are
  // silent: a missing prefetch only means the install falls back to the normal registry path.
  const prefetchPackage = async (packageName, version, registry) => {
    const target = tarballPathOf(packageName, version)
    try {
      const existing = readFileSync(target)
      if (existing.length > 0) return target
    } catch {
      // not cached yet
    }
    const dist = await distOf(packageName, version, ['https://registry.npmmirror.com', registry])
    if (!dist) return undefined
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number(settings.prefetchTimeoutMs) || DEFAULTS.prefetchTimeoutMs)
    try {
      const response = await fetch(dist.tarball, { signal: controller.signal, headers: { accept: 'application/octet-stream' } })
      if (!response.ok) return undefined
      const buffer = Buffer.from(await response.arrayBuffer())
      if (!buffer.length) return undefined
      if (dist.integrity) {
        const [algorithm, expected] = String(dist.integrity).split('-')
        const actual = createHash(algorithm).update(buffer).digest('base64')
        if (actual !== expected) return undefined
      } else if (dist.shasum) {
        const actual = createHash('sha1').update(buffer).digest('hex')
        if (actual !== String(dist.shasum)) return undefined
      }
      await mkdir(join(cacheDir(), 'pkg'), { recursive: true })
      await writeFile(target, buffer)
      return target
    } catch {
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  const parseGithubUrl = (url) => {
    const match = String(url ?? '').match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
    return match ? { owner: match[1], repo: match[2] } : null
  }

  // Race every mirror and keep the first complete body; the losers are aborted. A HEAD probe
  // would be cheaper but several mirrors answer HEAD differently from GET.
  const raceArchive = async (owner, repo, sha) => {
    const urls = (settings.gitMirrors ?? DEFAULTS.gitMirrors)
      .map((template) => template.replace('{owner}', owner).replace('{repo}', repo).replace('{sha}', sha))
    const started = Date.now()
    const controllers = urls.map(() => new AbortController())
    const attempts = urls.map(async (url, index) => {
      const timer = setTimeout(() => controllers[index].abort(), Number(settings.archiveProbeMs) || DEFAULTS.archiveProbeMs)
      try {
        const response = await fetch(url, { signal: controllers[index].signal, headers: { accept: 'application/gzip,*/*' } })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        clearTimeout(timer)
        // Headers arrived: this mirror is the winner; stop the others.
        for (const [other, controller] of controllers.entries()) if (other !== index) controller.abort()
        const declared = Number(response.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > (Number(settings.archiveMaxBytes) || DEFAULTS.archiveMaxBytes)) {
          throw new Error('archive too large: ' + declared)
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        if (!buffer.length) throw new Error('empty body')
        return { url, buffer, ms: Date.now() - started }
      } catch (error) {
        clearTimeout(timer)
        throw error
      }
    })
    try {
      return await Promise.any(attempts)
    } catch {
      return null
    }
  }

  const installTargetOf = (packageName, version) => {
    const source = version?.source
    if (source?.type === 'git' && source.url && /^[0-9a-f]{40}$/i.test(String(source.commit ?? ''))) {
      // pnpm derives the dependency alias from the spec; a raw git+ URL that ends in .git
      // produces an invalid alias (ERR_PNPM_INVALID_DEPENDENCY_NAME), while the github:
      // shorthand pins the same commit and installs cleanly (measured on dsh-brewreel).
      const gh = String(source.url).match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
      if (gh) return { spec: `github:${gh[1]}/${gh[2]}#${source.commit}`, registry: undefined };
      const base = String(source.url).replace(/\.git$/, '')
      return { spec: `git+${base}.git#${source.commit}`, registry: undefined }
    }
    return { spec: `${packageName}@${version.version}`, registry: source?.registry }
  }

  const compatibilityOf = (version) => ({ compatible: true, declared: version?.engines?.dsh, verified: false })

  // One HTTP probe of "<registry>/<name>/<version>". Only an explicit 404 counts as
  // "absent"; a timeout or a network error stays "unknown" so a working install is never
  // blocked by a failed check. The mirrors answer a miss in 1-4 s and sometimes hang, so
  // every candidate is probed in parallel and the whole check is bounded by one timeout.
  const probeOnce = async (url, timeoutMs) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || Number(settings.probeTimeoutMs) || DEFAULTS.probeTimeoutMs)
    try {
      const response = await fetch(url, { method: 'HEAD', signal: controller.signal })
      return response.ok ? 'ok' : response.status === 404 ? 'absent' : `unknown-${response.status}`
    } catch (error) {
      return error?.name === 'AbortError' ? 'unknown-timeout' : 'unknown-network'
    } finally {
      clearTimeout(timer)
    }
  }

  // Two phases, because a hit is what matters for the 5 s budget: the declared registry is
  // asked first with a short budget (a hit answers in tens of milliseconds), and only a
  // miss pays for the full parallel sweep across the mirrors.
  // `packageNames` holds the market name and, when the index renamed a duplicate, the
  // original npm name kept in `title`. The verdict stays conservative: "absent" is only
  // reported when nothing was served and at least one candidate answered with a real 404.
  const probeRegistry = async (packageNames, version, declared) => {
    const declaredBase = declared ? String(declared).replace(/\/+$/, '') : null
    const names = packageNames.filter((value, index, all) => value && all.indexOf(value) === index)
    const checked = []
    const urlOf = (registry, packageName) => `${registry}/${String(packageName).replace('/', '%2f')}/${version}`

    // Phase 1: the fast mirror and the declared registry are both asked inside one short
    // budget. The mirror is the only one that reliably answers here, so asking it first (and
    // in parallel) keeps the common case at ~70-230 ms instead of a serial 1.5 s round.
    const quick = ['https://registry.npmmirror.com', declaredBase].filter(
      (value, index, all) => value && all.indexOf(value) === index,
    )
    const first = await Promise.all(
      quick.flatMap((registry) => names.map(async (packageName) => ({
        package: packageName,
        registry,
        state: await probeOnce(urlOf(registry, packageName), settings.probeFastMs),
      }))),
    )
    checked.push(...first)
    const hit = first.find((item) => item.state === 'ok')
    if (hit) return { verdict: 'ok', package: hit.package, registry: hit.registry, checked, fast: true }

    const registries = [declaredBase, ...(settings.registryFallbacks ?? []), REGISTRY_DEFAULT].filter(
      (value, index, all) => value && all.indexOf(value) === index,
    )
    const rest = await Promise.all(
      names.flatMap((packageName) => registries.map(async (registry) => {
        if (checked.some((item) => item.package === packageName && item.registry === registry)) return null
        return { package: packageName, registry, state: await probeOnce(urlOf(registry, packageName)) }
      })),
    )
    checked.push(...rest.filter(Boolean))
    const served = checked.find((item) => item.state === 'ok')
    if (served) return { verdict: 'ok', package: served.package, registry: served.registry, checked }
    const definitive = checked.some((item) => item.state === 'absent')
    return { verdict: definitive ? 'absent' : 'unknown', package: null, registry: null, checked }
  }

  // The published DSH document is metadata-only since the 2026-11-06 crawl: a candidate
  // arrives as name + title + category, which is not enough to judge whether a package
  // does the job. The registry packument still carries the description, one small request
  // per candidate, so the visible rows are filled in before they reach the model.
  const descriptionCache = new Map()

  // One request per candidate also answers a second question for free: a package that both
  // registries deny does not exist, which is true for a large share of the index. That
  // lets a search row say `installable: false` instead of letting the model pick a ghost.
  const registryLookup = async (packageName) => {
    stats.packumentFetches += 1
    const cached = descriptionCache.get(packageName)
    if (cached && Date.now() - cached.at < (Number(settings.enrichCacheTtlMs) || DEFAULTS.enrichCacheTtlMs)) {
      return cached
    }
    // Measured on this host: the mirror answers a full packument in 41 ms while npmjs.org
    // needs more than 900 ms, so both are asked at once and the first real description wins.
    const registries = settings.enrichRegistries ?? DEFAULTS.enrichRegistries
    const attempt = async (registry) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Number(settings.enrichTimeoutMs) || DEFAULTS.enrichTimeoutMs)
      try {
        const base = String(registry).replace(/\/+$/, '')
        const path = String(packageName).replace('/', '%2f')
        const response = await fetch(`${base}/${path}`, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
        if (response.status === 404) {
          const missing = new Error('missing')
          missing.code = 'missing'
          throw missing
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const document = await response.json()
        const latest = document?.['dist-tags']?.latest
        const description = document?.versions?.[latest]?.description ?? document?.description
        if (typeof description !== 'string' || !description.trim()) throw new Error('no description')
        return { description, at: Date.now() }
      } finally {
        clearTimeout(timer)
      }
    }
    const settled = await Promise.allSettled(registries.map(attempt))
    const hit = settled.find((item) => item.status === 'fulfilled')
    // One registry answering 404 is enough to call it missing: both are mirrors of the same
    // public store, and the mirror often hangs instead of answering, so requiring "all
    // missing" would never fire for exactly the packages that need it.
    const denied = settled.some((item) => item.status === 'rejected' && item.reason?.code === 'missing')
    const result = hit ? hit.value : { description: undefined, missing: denied, at: Date.now() }
    descriptionCache.set(packageName, result)
    return result
  }

  // ---- description map ---------------------------------------------------------
  // One CDN fetch per 12 h builds `name -> description` for the whole catalogue, so a
  // search row gets its text locally instead of one registry round-trip per candidate.
  const descriptions = { at: 0, map: new Map() }
  let descriptionLoading

  const descriptionPath = () => join(cacheDir(), 'descriptions.json')

  // Sidecar first: `descriptions.<lang>.json` carries the untruncated text.
  const descriptionsUrlFor = (indexUrl) => String(indexUrl ?? '').replace(/index\.([a-z]{2})\.json$/, 'descriptions.$1.json')

  // One fetch, bounded, JSON only: a missing sidecar (the site has not crawled since it was
  // added) must stay cheap and must never fail the caller.
  const fetchSidecar = async (url) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Number(settings.fetchTimeoutMs) || DEFAULTS.fetchTimeoutMs)
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
      if (!response.ok) return undefined
      return await response.json()
    } finally {
      clearTimeout(timer)
    }
  }

  const loadDescriptionMap = async () => {
    const ttl = Number(settings.descriptionTtlMs) || DEFAULTS.descriptionTtlMs
    // Free path first: if the index we already hold is description-rich, project it instead
    // of paying for a separate sidecar fetch.
    try {
      const indexUrl = pickIndexUrl()
      if (indexUrl) {
        // Untruncated descriptions, when the site publishes them.
        const sidecarUrl = descriptionsUrlFor(indexUrl)
        if (sidecarUrl && sidecarUrl !== indexUrl) {
          const cachedSidecar = descriptions.sidecarUrl === sidecarUrl && Date.now() - (descriptions.sidecarAt ?? 0) < ttl
          if (!cachedSidecar) {
            const fetched = await fetchSidecar(sidecarUrl).catch(() => undefined)
            if (fetched?.descriptions && typeof fetched.descriptions === 'object') {
              const entries = Object.entries(fetched.descriptions)
              if (entries.length) {
                descriptions.map = new Map(entries)
                descriptions.at = Date.now()
                descriptions.sidecarUrl = sidecarUrl
                descriptions.sidecarAt = Date.now()
                stats.descriptionSidecarHits = (stats.descriptionSidecarHits ?? 0) + 1
                await writeFile(descriptionPath(), JSON.stringify({ at: descriptions.at, map: Object.fromEntries(descriptions.map) })).catch(() => {})
                return descriptions.map
              }
            }
          } else {
            descriptions.map = descriptions.map ?? new Map()
            stats.descriptionMapHits += 1
            return descriptions.map
          }
        }
        const document = await readIndex(indexUrl)
        const plugins = document.plugins ?? []
        if (plugins.length) {
          let covered = 0
          for (const plugin of plugins) if (textOfLocalized(plugin.description)) covered += 1
          if (covered / plugins.length >= 0.8) {
            const projected = new Map()
            for (const plugin of plugins) {
              const text = textOfLocalized(plugin.description)
              if (text) projected.set(plugin.name, text)
            }
            descriptions.at = Date.now()
            descriptions.map = projected
            stats.descriptionMapHits += 1
            return projected
          }
        }
      }
    } catch {
      // fall through to the sidecar sources
    }
    if (descriptions.map.size && Date.now() - descriptions.at < ttl) {
      stats.descriptionMapHits += 1
      return descriptions.map
    }
    if (descriptionLoading) return descriptionLoading
    descriptionLoading = (async () => {
      try {
        const parsed = JSON.parse(await readFile(descriptionPath(), 'utf8'))
        if (parsed?.map && Date.now() - parsed.at < ttl) {
          descriptions.at = parsed.at
          descriptions.map = new Map(Object.entries(parsed.map))
          stats.descriptionMapHits += 1
          return descriptions.map
        }
      } catch {
        // no usable local copy
      }
      try {
        stats.descriptionMapLoads += 1
        const map = new Map()
        const sources = settings.descriptionSources ?? (settings.descriptionSource ? [settings.descriptionSource] : [])
        for (const source of sources) {
          try {
            const document = await readIndex(source)
            if (document?.descriptions && typeof document.descriptions === 'object') {
              for (const [name, text] of Object.entries(document.descriptions)) {
                if (typeof text === 'string' && text.trim()) map.set(name, text)
              }
            } else {
              for (const plugin of document.plugins ?? []) {
                const text = textOfLocalized(plugin.description)
                if (text) map.set(plugin.name, text)
              }
            }
            if (map.size) break
          } catch {
            // try the next source
          }
        }
        if (map.size) {
          descriptions.at = Date.now()
          descriptions.map = map
          try {
            await mkdir(cacheDir(), { recursive: true })
            await writeFile(descriptionPath(), JSON.stringify({ at: descriptions.at, map: Object.fromEntries(map) }))
          } catch {
            // the map is a cache; failing to persist it is not an error
          }
        }
        return descriptions.map
      } catch {
        return descriptions.map
      } finally {
        descriptionLoading = undefined
      }
    })()
    return descriptionLoading
  }

  const enrichDiag = { siteMs: 0, descMs: 0, pending: 0, network: 0 }
  const enrich = async (rows) => {
    if (!settings.enrichDescriptions) return rows
    const tSite = Date.now()
    const facts = await installFactsOf(pickIndexUrl())
    const siteMs = Date.now() - tSite
    // Fill from the site index first: no network at all.
    let filledLocally = 0
    // Install facts need no network once the (41 KB) diff document is on disk.
    for (const row of rows) {
      if (!row) continue
      const installable = installableOf(facts, row.name)
      if (typeof installable !== 'boolean') continue
      row.installable = installable
      row.installableSource = 'site-facts'
      filledLocally += 1
    }
    let descMs = 0
    enrichDiag.siteMs = siteMs
    enrichDiag.descMs = descMs
    const pending = rows.filter((row) => row && !row.description)
    enrichDiag.pending = pending.length
    if (!pending.length) return rows
    const tDesc = Date.now()
    const map = await loadDescriptionMap()
    descMs = Date.now() - tDesc
    await Promise.all(pending.map(async (row) => {
      if (row.source === 'git') {
        row.installable = true
        row.installableSource = 'git'
        return
      }
      const local = map.get(row.name)
      if (local) {
        row.description = local
        row.descriptionSource = 'index'
        return
      }
      const found = await registryLookup(row.name)
      if (found.description) {
        row.description = found.description
        row.descriptionSource = 'registry'
        return
      }
      if (!found.missing) return
      // The index renames duplicates; before calling a row uninstallable, check the real
      // package name kept in `title` (this is the same alias rule `load` uses).
      const title = typeof row.title === 'string' ? row.title : undefined
      if (title && title !== row.name && NPM_NAME.test(title)) {
        const aliased = await registryLookup(title)
        if (aliased.description) {
          row.description = aliased.description
          row.descriptionSource = 'registry-alias'
          row.installable = true
          row.installAs = title
          return
        }
        if (!aliased.missing) return
      }
      row.installable = false
      row.installableSource = 'registry-404'
    }))
    return rows
  }

  const toListing = (plugin) => {
    const versions = (plugin.versions ?? []).map((version) => ({
      version: version.version,
      publishTimestamp: version.publishTimestamp,
      install: installTargetOf(plugin.name, version),
      compatibility: compatibilityOf(version),
      source: version.source,
    }))
    const sorted = versions.slice().sort((a, b) => (b.publishTimestamp ?? 0) - (a.publishTimestamp ?? 0))
    return {
      name: plugin.name,
      title: plugin.title,
      description: plugin.description,
      metadata: {
        category: plugin.metadata?.category,
        labels: plugin.metadata?.labels ?? [],
        sortKeys: plugin.metadata?.sortKeys ?? {},
        keywords: plugin.metadata?.keywords ?? [],
      },
      repository: plugin.repository,
      versions,
      defaultVersion: sorted[0]?.version,
      installation: { status: 'unknown' },
    }
  }

  const findEntry = async (packageName) => {
    const { api, url } = requireMarket()
    // Local first: this process already holds the document (memory, else disk), while the
    // market service refetches the whole thing on its own 10-minute TTL.
    try {
      const document = await readIndex(url)
      const found = (document.plugins ?? []).find(
        (plugin) => String(plugin.name).toLowerCase() === String(packageName).toLowerCase(),
      )
      if (found) return { entry: toListing(found), url }
    } catch {
      // fall through: the service may still know the name
    }
    try {
      const entry = await api.entry(url, packageName)
      if (entry) return { entry, url }
    } catch (error) {
      if (!/timeout|aborted|fetch/i.test(String(error?.message ?? ''))) throw error
    }
    throw new Error(`${packageName} is not listed in ${url}`)
  }

  // Setup cost the description admits to. Not a filter: a candidate that needs an account or
  // an open page is still installable, it just should not outrank a self-contained one.
  const SETUP_RISK_PATTERNS = [
    { flag: 'needs-account', re: /余额|额度|充值|付费|按次计费|api\s*key|apikey|密钥|credit|billing|subscription/i },
    { flag: 'needs-page', re: /画布页面|页面处于打开|需要打开|网页端打开|open the (canvas|page)|browser open/i },
    { flag: 'needs-install', re: /需要先安装|依赖.{0,6}安装|先装好|requires? .{0,12}installed/i },
  ]

  const setupRisksOf = (row) => {
    // Catalog tags are English vocabulary for Chinese-described rows, so they join the text.
    const text = [row?.name, row?.title, row?.description, ...(Array.isArray(row?.tags) ? row.tags : [])].filter((item) => typeof item === 'string').join(' ')
    return SETUP_RISK_PATTERNS.filter((entry) => entry.re.test(text)).map((entry) => entry.flag)
  }

  // Capability words that appear in both languages. Only the pairs are bridged — a query
  // term that is not in this table gains nothing, so the table cannot inflate scoring.
  // Measured on the 30-need corpus: 0.4 keeps precision at 0.900 and top-5 recall at 0.900,
  // while 0.6/0.8 let one wrong auto-pick through.
  const BRIDGE_WEIGHT = Number(settings.bridgeWeight) || DEFAULTS.bridgeWeight

  // Search runs against our own copy, not the service: the served document has no
  // description any more, so the local pass joins it with the description map (one CDN
  // fetch per 12 h) and answers in milliseconds with a real cache hit.
  const search = async (args) => {
    const { api, url } = requireMarket()
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 40)
    const offset = Math.max(Number(args.offset) || 0, 0)
    const needle = String(args.query ?? '').trim().toLowerCase()
    const expandedQuery = needle ? expandTerms(termsOf(needle)) : { list: [], bridged: new Set() }
    const queryTerms = expandedQuery.list
    stats.searches += 1
    try {
      const document = await readIndex(url)
      const map = settings.descriptionSearch ? await loadDescriptionMap() : new Map()
      // Local rows otherwise carry no install state; one listBundles call fills it in.
      const installedNames = new Set(((await manager()?.listBundles().catch(() => [])) ?? []).map((bundle) => bundle.name))
      const matches = []
      for (const plugin of document.plugins ?? []) {
        if (args.category && plugin.metadata?.category !== args.category) continue
        let rank = 0
        if (needle) {
          const name = String(plugin.name ?? '').toLowerCase()
          const title = String(textOfLocalized(plugin.title) ?? '').toLowerCase()
          const description = String(textOfLocalized(plugin.description) ?? map.get(plugin.name) ?? '').toLowerCase()
          if (name === needle) rank = 1000
          else if (name.includes(needle)) rank = 500
          else if (title.includes(needle)) rank = 300
          else if (description.includes(needle)) rank = 100
          else {
            // A bridged term (语音 <-> voice) still counts, but ranks below a direct hit.
            const bridged = queryTerms.filter((term) => term !== needle).find((term) => name.includes(term) || title.includes(term) || description.includes(term))
            rank = bridged ? 60 : -1
          }
        }
        if (rank >= 0) matches.push({ plugin, rank })
      }
      matches.sort((a, b) => b.rank - a.rank || String(a.plugin.name).localeCompare(String(b.plugin.name)))
      const pool = matches.slice(offset, offset + Math.max(limit * 3, 24))
      const rows = pool.map(({ plugin }) => {
        const row = summarize(toListing(plugin))
        row.installed = installedNames.has(plugin.name) ? 'installed' : 'not-installed'
        if (!row.description) {
          const local = map.get(plugin.name)
          if (local) {
            row.description = local
            row.descriptionSource = 'index'
          }
        }
        return row
      })
      const enrichStarted = Date.now()
    const enriched = await enrich(rows)
    const enrichMs = Date.now() - enrichStarted
      const usable = enriched.filter((row) => row.installable !== false)
      const hidden = enriched.length - usable.length
      const entries = collapse(usable).slice(0, limit)
      return {
        index: url,
        source: 'local',
        total: matches.length,
        offset,
        nextOffset: matches.length > offset + pool.length ? offset + pool.length : undefined,
        installable: usable.length,
        uninstallableHidden: hidden || undefined,
        entries,
      }
    } catch (error) {
      // No local copy at all: the service is the only remaining reader.
      const result = await api.search(url, {
        text: args.query ?? undefined,
        category: args.category ?? undefined,
        sort: { kind: 'relevance' },
        offset: 0,
        limit,
      })
      const rows = (result.entries ?? []).map(summarize)
      return { index: url, source: 'service', total: result.total, entries: await enrich(rows) }
    }
  }


  const suggest = async (args) => {
    const { url } = requireMarket()
    // Loaded before scoring so the popularity tiebreak can see it.
    const catalog = await catalogOf()
    // Which common need is this? A matched domain lifts its verified candidates slightly.
    const domain = domainMatchOf(args.task ?? args.query ?? args.need)
    const domainNames = domainNamesOf(domain)
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20)
    const offset = Math.max(Number(args.offset) || 0, 0)
    const expanded = expandTerms(termsOf(args.task ?? args.query))
    const terms = expanded.list
    const bridgedTerms = expanded.bridged
    if (!terms.length) throw new Error('task is required for suggest')
    const document = await readIndex(url)
    const map = settings.descriptionSearch ? await loadDescriptionMap() : new Map()
    const installedNames = new Set(((await manager()?.listBundles().catch(() => [])) ?? []).map((bundle) => bundle.name))
    const plugins = document.plugins ?? []
    // IDF pass: a term that appears in most entries (dsh, plugin, harness) must not decide
    // the ranking, so each hit is scaled by how rare the term is in this catalogue.
    const documentFrequency = new Map(terms.map((term) => [term, 0]))
    const tagsOf = (name) => (catalog?.map?.[String(name)]?.tags ?? [])
    const fieldsOf = (plugin) => ({
      name: String(plugin.name ?? '').toLowerCase(),
      title: String(textOfLocalized(plugin.title) ?? '').toLowerCase(),
      description: String(map.get(plugin.name) ?? textOfLocalized(plugin.description) ?? '').toLowerCase(),
      // Community tags are English vocabulary; they make an English need match a Chinese row.
      tags: tagsOf(plugin.name).join(' ').toLowerCase(),
    })
    const cache = new Map()
    for (const plugin of plugins) {
      const fields = fieldsOf(plugin)
      cache.set(plugin.name, fields)
      const haystack = fields.name + ' ' + fields.title + ' ' + fields.description + ' ' + fields.tags
      for (const term of terms) if (haystack.includes(term)) documentFrequency.set(term, documentFrequency.get(term) + 1)
    }
    const total = Math.max(plugins.length, 1)
    // Uncapped IDF rewarded accidental rarity: 整理 appears in three titles out of 13,854 rows,
    // which made "organize" the strongest term in the catalogue and pushed real transcription
    // plugins off a 录音 request. Cap it so one term can never carry a row past the floor alone.
    const IDF_CAP = Number(settings.idfCap ?? DEFAULTS.idfCap)
    const idfOf = (term) => Math.min(IDF_CAP, Math.log(1 + total / (1 + (documentFrequency.get(term) ?? 0))))
    let scored = []
    for (const plugin of plugins) {
      const fields = cache.get(plugin.name) ?? fieldsOf(plugin)
      let score = 0
      let matched = 0
      for (const term of terms) {
        const weight = idfOf(term) * (bridgedTerms.has(term) ? BRIDGE_WEIGHT : 1)
        if (fields.name.includes(term)) score += weight * 3
        if (fields.title.includes(term)) score += weight * 2
        if (fields.description.includes(term)) score += weight * 2
        // Tags are a weaker signal than prose: enough to lift a row, not to decide it.
        if (fields.tags && fields.tags.includes(term)) score += weight * 1.2
        if (fields.name.includes(term) || fields.title.includes(term) || fields.description.includes(term) || (fields.tags && fields.tags.includes(term))) matched += 1
      }
      if (score > 0 && matched === 1 && !terms.some((term) => fields.name.includes(term))) score *= 0.5
      if (score > 0) {
        const risks = setupRisksOf({ name: fields.name, title: fields.title, description: fields.description })
        const penalty = risks.length ? (Number(settings.setupRiskPenalty) || DEFAULTS.setupRiskPenalty) : 1
        const boosted = domainNames.has(String(plugin.name)) ? score * (Number(settings.domainBoost) || DEFAULTS.domainBoost) : score
        scored.push({ plugin, score: Math.round(boosted * penalty * 100) / 100, risks, domain: domainNames.has(String(plugin.name)) ? domain.id : undefined })
      }
    }
    scored.sort((a, b) => b.score - a.score || String(a.plugin.name).localeCompare(String(b.plugin.name)))
    // Second pass: boost the candidates that share the leading category, then re-sort. Only
    // a boost — filtering by category measured worse (precision 0.80 -> 0.733).
    const boost = Number(settings.categoryBoost) || 0
    const leadCategory = scored[0]?.plugin?.metadata?.category
    if (boost > 0 && leadCategory) {
      for (const row of scored) {
        if (row.plugin?.metadata?.category === leadCategory) row.score = Math.round(row.score * (1 + boost) * 100) / 100
      }
      scored.sort((a, b) => b.score - a.score || String(a.plugin.name).localeCompare(String(b.plugin.name)))
    }
    // Hybrid recall. Fusing two rankers that fail on different rows measured +2.35pt R@1 and
    // +3.45pt R@20 over BM25 alone, and it costs one query encode plus a dot product per
    // candidate. It stays off the critical path: no matrix, no fusion, lexical order stands.
    let fusion = false
    if (settings.fusionSearch !== false) {
      const fused = await fuseCandidates(scored, document, args.task ?? args.query).catch(() => undefined)
      if (fused) {
        scored = fused
        fusion = true
        stats.fusionHits = (stats.fusionHits ?? 0) + 1
      }
    }
    const rows = scored.slice(offset, offset + Math.max(limit * 2, 10)).map(({ plugin, score, risks }) => {
      const row = summarize(toListing(plugin))
      row.matchScore = score
      if (risks?.length) row.setupRisk = risks
      row.installed = installedNames.has(plugin.name) ? 'installed' : 'not-installed'
      if (!row.description) {
        const local = map.get(plugin.name)
        if (local) {
          row.description = local
          row.descriptionSource = 'index'
        }
      }
      return row
    })
    const suggestEnrichStart = Date.now()
    const enriched = await enrich(rows)
    // Attach stars/downloads/verified when the community catalog is already on disk, then
    // let that break ties: a better textual match still wins.
    if (catalog?.map) {
      for (const row of enriched) {
        const hit = catalog.map[row?.name]
        // Only tags are published: the registry's stars/downloads are synthetic (measured:
        // dsh-our-free-model reports 64,573 stars; claude-flow 81,107 stars with 7 downloads)
        // and its verified flag is true for 93% of rows, so none of them may rank anything.
        if (hit?.tags?.length) row.tags = hit.tags
      }
    }
    const enrichMs = Date.now() - suggestEnrichStart
    // Warm the local cache for the leaders while the caller is still reading the list.
    if (settings.prefetch) {
      const leaders = enriched.filter((row) => row.source !== 'git').slice(0, Number(settings.prefetchLimit) || 1)
      void Promise.all(leaders.map((row) => prefetchPackage(row.name, row.version, row.registry))).catch(() => {})
    }
    const usable = enriched.filter((row) => row.installable !== false)
    const entries = collapse(usable).slice(0, limit)
    // Opt-in model pass: reorder by what the model thinks actually fits, and say why. A failure
    // context ("the repo 404'd") travels with the request so the pick can route around it.
    // Nothing here installs anything.
    let judged
    if (args.judge === true) {
      const verdict = await llmJudge(args.task ?? args.query ?? '', entries, { failure: args.context ?? args.failure })
      if (verdict?.ok) {
        judged = {
          pick: verdict.pick?.name,
          confidence: verdict.confidence,
          why: verdict.why,
          model: verdict.model,
          considered: verdict.considered,
          cached: verdict.cached === true,
          context: args.context ?? args.failure,
        }
        if (verdict.pick) {
          const picked = entries.find((row) => row.name === verdict.pick.name)
          if (picked) {
            entries.splice(entries.indexOf(picked), 1)
            entries.unshift(picked)
          }
        }
      } else if (verdict) {
        judged = { error: verdict.reason, raw: verdict.raw, model: verdict.model }
      }
    }
    const consumed = rows.length
    return {
      enrichMs,
      enrichPhases: { ...enrichDiag },
      judged,
      index: url,
      terms: terms.slice(0, 8),
      candidates: scored.length,
      fusion: fusion || undefined,
      offset,
      nextOffset: scored.length > offset + consumed ? offset + consumed : undefined,
      uninstallableHidden: enriched.length - usable.length || undefined,
      entries,
    }
  }

  // 'Find me whatever does X' in one call: suggest, then load the winner when the ranking is
  // decisive. Anything ambiguous comes back as candidates, so a human/agent decides.
  // Model-written queries + BM25 → index rows shaped like `suggest` output, so the rest of
  // `ensure` does not care which recall produced them.
  const recallViaSelect = async (need, failure, limit) => {
    const rewritten = await rewriteQueries(need, failure)
    if (!rewritten?.ok || !rewritten.queries?.length) return undefined
    const { url } = requireMarket()
    const document = await readIndex(url)
    const { index } = await bm25Of(document)
    const best = new Map()
    for (const query of rewritten.queries) {
      const run = bm25Search(index, query, { limit: 20 })
      for (const hit of run.hits) {
        const seen = best.get(hit.id)
        if (!seen || hit.score > seen.score) best.set(hit.id, hit)
      }
    }
    const byName = new Map((document?.plugins ?? []).map((plugin) => [plugin.name, plugin]))
    const installedNames = new Set(((await manager()?.listBundles().catch(() => [])) ?? []).map((bundle) => bundle.name))
    const entries = [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((hit) => {
        const plugin = byName.get(hit.id)
        if (!plugin) return undefined
        const row = summarize(toListing(plugin))
        // Same scale as the lexical scorer (which multiplies ~idf x3-2): keep the ranking
        // comparable so the existing floor still means something.
        row.matchScore = Math.round(hit.score * 4 * 100) / 100
        row.installed = installedNames.has(plugin.name) ? 'installed' : 'not-installed'
        return row
      })
      .filter(Boolean)
    return { entries, queries: rewritten.queries, rewriteCached: rewritten.cached === true }
  }

  const ensure = async (args) => {
    const need = args.need ?? args.task ?? args.query
    if (!String(need ?? '').trim()) throw new Error('need is required for ensure')
    // Tools that are already bound and could satisfy the need, shaped like index rows so the
  // judge can weigh them against installable plugins.
  const installedToolRows = () => {
    try {
      const schemas = ctx.tools?.schemas?.() ?? []
      return schemas
        .filter((schema) => schema?.name && !KEEP_VISIBLE.includes(schema.name) && schema.name !== 'lazy_plugin')
        .map((schema) => ({
          name: schema.name,
          title: 'already installed',
          description: String(schema.description ?? '').replace(/\s+/g, ' ').slice(0, 180),
          installed: 'tool',
          matchScore: 0,
        }))
    } catch {
      return []
    }
  }

  // The judge sees the shortlist, so give it a wider net than the display default.
    const want = Math.min(Math.max(Number(args.limit) || 10, 5), 12)
    // Recall: model queries + BM25 first, lexical as the fallback.
    const recalled = String(settings.recall ?? 'select') === 'select' && args.recall !== 'lexical'
      ? await recallViaSelect(need, args.context ?? args.failure, want).catch(() => undefined)
      : undefined
    const shortlist = recalled?.entries?.length
      ? { entries: recalled.entries }
      : await suggest({ task: need, limit: want })
    const entries = shortlist.entries ?? []
    // Skip packages that failed a few days ago: repeating the same pick is the most
    // expensive mistake this tool can make.
    const failed = await readFailed()
    const viable = entries.filter((entry) => !failureIsFresh(failed[entry.name]))
    const skipped = entries.length - viable.length
    const [first, second] = viable
    if (!first) return { need, action: 'no-match', proceedWithoutPlugin: true, skippedRecentFailures: skipped || undefined, candidates: [], hint: 'the market has nothing decisive for this need: build it directly instead of retrying with a different wording' }
    if (first.installed === 'installed') return { need, action: 'already-installed', pick: first, candidates: entries }
    const score = Number(first.matchScore) || 0
    const runnerUp = Number(second?.matchScore) || 0
    // Model judgement first. `judged.pick` may be null, which is a real answer: nothing fits.
    const judgeEnabled = String(settings.judgeMode ?? DEFAULTS.judgeMode) !== 'off' && args.judge !== false
    // Existing tools first in the list, installable plugins after: the model sees one menu.
    const bound = args.installed === false ? [] : installedToolRows()
    const pool = [...bound.slice(0, Number(settings.judgeInstalledCandidates) || DEFAULTS.judgeInstalledCandidates), ...viable]
    const judged = judgeEnabled ? await llmJudge(need, pool, { failure: args.context ?? args.failure }) : undefined
    const failure = args.context ?? args.failure
    const judgeMin = failure
      ? (Number(settings.judgeMinConfidenceOnFailure) || DEFAULTS.judgeMinConfidenceOnFailure)
      : (Number(settings.judgeMinConfidence) || DEFAULTS.judgeMinConfidence)
    if (judged?.ok) {
      if (judged.none) {
        return {
          need,
          action: 'no-plugin-needed',
          judged: { confidence: judged.confidence, why: judged.why, model: judged.model, considered: judged.considered, cached: judged.cached === true, context: args.context ?? args.failure },
          hint: 'the model judged this needs no plugin: do it with the session itself',
        }
      }
      if (judged.pick?.installed === 'tool' && judged.confidence >= judgeMin) {
        // Nothing to install: the capability is already bound, so hand over the call shape.
        return {
          need,
          action: 'already-covered',
          tool: judged.pick.name,
          next: { action: 'invoke', tool: judged.pick.name, arguments: {} },
          judged: { confidence: judged.confidence, why: judged.why, model: judged.model, considered: judged.considered, cached: judged.cached === true, context: args.context ?? args.failure },
          hint: 'call lazy_plugin action=invoke with this tool instead of installing anything',
        }
      }
      if (judged.pick && judged.confidence >= judgeMin) {
        const chosen = judged.pick
        const base = { need, pick: chosen, recall: recalled?.entries?.length ? 'select' : 'lexical', recallQueries: recalled?.queries, judged: { confidence: judged.confidence, why: judged.why, model: judged.model, considered: judged.considered, cached: judged.cached === true, context: args.context ?? args.failure }, skippedRecentFailures: skipped || undefined }
        if (args.auto === false || settings.autoSelectEnabled === false) return { ...base, action: 'would-load', candidates: viable }
        if (args.background === true) {
          const requestId = startBackgroundLoad(chosen.name, { activate: 'proxy', keep: args.keep })
          return { ...base, action: 'loading', background: true, requestId, hint: 'The pick is installing in the background; call action=wait to collect it.' }
        }
        const loaded = await load({ name: chosen.name, activate: 'proxy', keep: args.keep }, undefined)
        // Hand over the call shape: an install that nobody then uses is a wasted turn.
        const addedTools = Array.isArray(loaded?.addedTools) ? loaded.addedTools.slice(0, 3) : []
        const next = addedTools.length ? { action: 'invoke', tool: addedTools[0], arguments: {} } : undefined
        // `use: true` closes the loop here instead of asking for a second call.
        let used
        if (args.use === true && addedTools.length && !loaded.rejected) {
          used = await invoke(
            { tool: addedTools[0], arguments: args.useArguments ?? {} },
            args.useExec,
          ).catch((error) => ({ error: String(error?.message ?? error) }))
        }
        return { ...base, action: loaded.rejected ? 'rejected' : 'loaded', next, used, addedTools: addedTools.length ? addedTools : undefined, candidates: viable, load: loaded }
      }
      // Second pass: rewrite the need into retrieval queries, retrieve again, judge again.
      const rewriteEnabled = String(settings.rewritePass ?? 'on') !== 'off' && args.rewrite !== false
      if (rewriteEnabled) {
        const rewritten = await rewriteQueries(need, failure)
        if (rewritten?.ok && rewritten.queries?.length) {
          const merged = new Map()
          // Parallel: each pass is local (no network), so four recalls cost one.
          const replays = await Promise.all(rewritten.queries.map((query) => suggest({ task: query, limit: 5 })))
          for (const replay of replays) {
            for (const row of replay.entries ?? []) if (!merged.has(row.name)) merged.set(row.name, row)
          }
          for (const row of viable) if (!merged.has(row.name)) merged.set(row.name, row)
          // Prompt size is the latency: cap the second pool (4 bound + the 8 best recalls).
          const ranked = [...merged.values()].sort((x, y) => (Number(y.matchScore) || 0) - (Number(x.matchScore) || 0)).slice(0, 8)
          const secondPool = [...bound.slice(0, 4), ...ranked]
          const second = await llmJudge(need, secondPool, { failure })
          const note = { passes: 2, queries: rewritten.queries, rewriteCached: rewritten.cached === true }
          if (second?.ok && second.none) {
            return { need, action: 'no-plugin-needed', ...note, judged: { confidence: second.confidence, why: second.why, model: second.model, considered: second.considered } }
          }
          if (second?.ok && second.pick?.installed === 'tool' && second.confidence >= judgeMin) {
            return { need, action: 'already-covered', tool: second.pick.name, next: { action: 'invoke', tool: second.pick.name, arguments: {} }, ...note, judged: { confidence: second.confidence, why: second.why, model: second.model, considered: second.considered } }
          }
          if (second?.ok && second.pick && second.confidence >= judgeMin) {
            const chosen = second.pick
            const base = { need, pick: chosen, ...note, judged: { confidence: second.confidence, why: second.why, model: second.model, considered: second.considered } }
            if (args.auto === false || settings.autoSelectEnabled === false) return { ...base, action: 'would-load', candidates: [...merged.values()] }
            const loaded = await load({ name: chosen.name, activate: 'proxy', keep: args.keep }, undefined)
            const addedTools = Array.isArray(loaded?.addedTools) ? loaded.addedTools.slice(0, 3) : []
            const next = addedTools.length ? { action: 'invoke', tool: addedTools[0], arguments: {} } : undefined
            let used
            if (args.use === true && addedTools.length && !loaded.rejected) {
              used = await invoke({ tool: addedTools[0], arguments: args.useArguments ?? {} }, args.useExec)
                .catch((error) => ({ error: String(error?.message ?? error) }))
            }
            return { ...base, action: loaded.rejected ? 'rejected' : 'loaded', next, used, addedTools: addedTools.length ? addedTools : undefined, candidates: [...merged.values()], load: loaded }
          }
          return {
            need,
            action: second?.pick ? 'needs-choice' : 'no-match',
            proceedWithoutPlugin: true,
            ...note,
            reason: second?.pick ? `second pass: ${second.pick.name} at ${second.confidence.toFixed(2)} (needs ${judgeMin})` : 'second pass found nothing decisive either',
            judged: { pick: second?.pick?.name, confidence: second?.confidence, why: second?.why, model: second?.model },
            candidates: [...merged.values()],
          }
        }
      }
      return {
        need,
        action: judged.pick ? 'needs-choice' : 'no-match',
        proceedWithoutPlugin: true,
        reason: judged.pick
          ? `the model saw ${judged.considered} candidates and chose ${judged.pick.name} but only with confidence ${judged.confidence.toFixed(2)} (needs ${judgeMin})`
          : 'the model judged that no candidate does this job',
        judged: { pick: judged.pick?.name, confidence: judged.confidence, why: judged.why, model: judged.model, cached: judged.cached === true, context: failure },
        skippedRecentFailures: skipped || undefined,
        candidates: viable,
      }
    }
    // No model reachable: fall back to the calibrated numbers, and say so.
    const floor = Number(settings.autoSelectScore) || DEFAULTS.autoSelectScore
    const margin = Number(settings.autoSelectMargin) || DEFAULTS.autoSelectMargin
    const family = sameFamily(first, second)
    const decisive = score >= floor && (!runnerUp || score >= runnerUp * margin || (family && settings.autoSelectFamilyExempt === true))
    if (!decisive) {
      return {
        need,
        action: 'needs-choice',
        decidedBy: 'lexical',
        judgeError: judged?.reason,
        judgeRaw: judged?.raw,
        reason: `top score ${score} (floor ${floor})${runnerUp ? `, margin ${(score / runnerUp).toFixed(2)}x (needs ${margin}x)` : ''}${family ? ', runner-up is the same family' : ''}`,
        skippedRecentFailures: skipped || undefined,
        // Same-family runner-up: narrow the choice to the two real options instead of 5 rows.
        familyCandidates: family ? viable.filter((row) => sameFamily(first, row)).slice(0, 2) : undefined,
        candidates: viable,
      }
    }
    if (args.auto === false || settings.autoSelectEnabled === false) return { need, action: 'would-load', pick: first, skippedRecentFailures: skipped || undefined, candidates: viable }
    if (args.background === true) {
      const requestId = startBackgroundLoad(first.name, { activate: 'proxy', keep: args.keep })
      return {
        need,
        action: 'loading',
        pick: first,
        background: true,
        requestId,
        skippedRecentFailures: skipped || undefined,
        hint: 'The pick is installing in the background; call action=wait with this requestId to collect the outcome.',
      }
    }
    const loaded = await load({ name: first.name, activate: 'proxy', keep: args.keep })
    return { need, action: loaded.rejected ? 'rejected' : 'loaded', pick: first, skippedRecentFailures: skipped || undefined, candidates: viable, load: loaded }
  }

  const load = async (args, exec) => {
    const started = Date.now()
    // Tool schemas are a separate API field sorted by name, so ANY change to the visible
    // tool set breaks the prompt prefix (see CREDITS.md). "session" installs without
    // switching the bundle on, which keeps this session cache-stable.
    const requested = args.activate ?? settings.defaultActivate
    // 'boot' is accepted as an alias of 'session': a deferred enable cannot be done
    // reliably from inside a plugin (see README), so it means "install now, enable later".
    const activate = requested === 'now' || requested === 'proxy' ? requested : 'session'
    const api = requireManager()
    // Fast path, before any index work: a package that is already in the profile only
    // needs switching on. This is what keeps a repeat `load` in the tens of milliseconds.
    const existing = await api.listBundles().catch(() => [])
    const found = (existing ?? []).find(
      (bundle) => bundle.name === args.name || bundle.name === realNameOf(args.name),
    )
    if (found) {
      if (found.enabled) {
        await addPool(found.name)
        await recordUsage(found.name, 'load')
        // An already-installed bundle still has to honour proxy mode, otherwise a package
        // that was installed by an interrupted call keeps its tools in the visible set.
        let masked
        if (activate === 'proxy') {
          await loadToolMap()
          const known = (toolMap.get(found.name) ?? []).filter((name) => visibleToolNames().has(name))
          if (known.length) {
            for (const name of known) hiddenTools.add(name)
            await saveHidden()
            await refreshRestrictions({ only: exec?.agent?.id })
            masked = known
          }
        }
        return {
          name: args.name,
          version: found.version,
          installedAs: found.name,
          alreadyInstalled: true,
          enabled: true,
          activated: true,
          proxied: masked,
          maskedHint: activate === 'proxy' && !masked
            ? 'its tools are unknown to this tool, so they are still visible; run adopt to learn and hide them'
            : undefined,
          ms: Date.now() - started,
        }
      }

      if (activate === 'session') {
        return {
          name: args.name,
          version: found.version,
          installedAs: found.name,
          alreadyInstalled: true,
          enabled: false,
          activated: false,
          promptImpact: 'none: installed only — it joins the composition when it is enabled later (a fast load, no download)',
          ms: Date.now() - started,
        }
      }
      const beforeEnable = activate === 'proxy' ? visibleToolNames() : undefined
      const on = await api.setBundleEnabled(found.name, true)
      if (!on.error) {
        loaded.add(found.name)
        await recordUsage(found.name, 'enable')
        let proxied = []
        if (beforeEnable) {
          proxied = [...visibleToolNames()].filter((name) => !beforeEnable.has(name))
          for (const name of proxied) hiddenTools.add(name)
          await saveHidden()
          await refreshRestrictions({ only: exec?.agent?.id })
          watchLateRegistrations(beforeEnable)
        }
        return {
          name: args.name,
          version: found.version,
          installedAs: found.name,
          alreadyInstalled: true,
          enabled: on.enabled,
          application: on.application,
          activated: true,
          proxied: proxied.length ? proxied : undefined,
          proxiedSchemas: proxied
            .map((name) => (ctx.tools?.schemas?.() ?? []).find((schema) => schema.name === name))
            .filter(Boolean),
          promptImpact: activate === 'proxy'
            ? (proxied.length
              ? 'none: the plugin is active, but its tools are hidden from the model and run through action=invoke'
              : 'none: the plugin added no new tools')
            : 'tool-set changed: the prompt prefix is rebuilt from the tool list',
          ms: Date.now() - started,
        }
      }
    }
    const phases = {}
    const mark = (name, from) => { phases[name] = Date.now() - from }
    let lap = Date.now()
    const { entry } = await findEntry(args.name)
    mark('lookup', lap)
    lap = Date.now()
    const versions = entry.versions ?? []
    const chosen = args.version
      ? versions.find((item) => item.version === args.version)
      : versions.find((item) => item.version === entry.defaultVersion) ?? versions[0]
    if (!chosen) throw new Error(`${args.name} has no version ${args.version}`)
    mark('resolve', lap)
    lap = Date.now()

    const compatibility = chosen.compatibility
    if (compatibility && compatibility.compatible === false) {
      throw new Error(
        `${args.name}@${chosen.version} requires ${JSON.stringify(compatibility.requirements ?? {})}; this runtime is ${compatibility.runtimeVersion}`,
      )
    }

    const result = await (async () => {
      const target = chosen.install
      let registry = target.registry ? String(target.registry).replace(/\/+$/, '') : undefined
      // The index frequently declares npmjs.org, which is slow from this host (measured: the
      // same package installed in 1.1 s against the mirror and 7.6 s against npmjs). Prefer the
      // mirror unless the entry names a different registry explicitly.
      if (!registry || /registry\.npmjs\.org/i.test(registry)) registry = 'https://registry.npmmirror.com'
      let probe
      let spec = target.spec
      const aliases = aliasNamesOf(entry)
      // A prefetched tarball already proved the version exists — probing it again would only add
      // latency (measured: 2.8 s of the 4.9 s total was this redundant check).
      let prefetchedFast
      if (settings.prefetch && !/^(git\+|github:)/.test(String(target.spec))) {
        prefetchedFast = await prefetchPackage(args.name, chosen.version, registry).catch(() => undefined)
        if (prefetchedFast) spec = 'file:' + prefetchedFast.replace(/\\/g, '/')
      }
      // The site's own index answers installability without a network round-trip.
      const facts = await installFactsOf(pickIndexUrl())
      const siteInstallable = installableOf(facts, args.name)
      // engines come from the format-1 index this process already holds.
      const siteRow = siteInstallable === undefined && !facts
        ? undefined
        : { installable: siteInstallable, engines: await enginesOf(args.name, pickIndexUrl()) }
      if (siteRow && siteRow.installable === false) {
        await recordFailure(args.name, chosen.version, 'not-installable')
        return {
          skipped: true,
          answer: {
            name: args.name,
            version: chosen.version,
            installable: false,
            reason: 'not-installable',
            hint: 'The market index marks this package as not installable (no registry serves it); nothing was installed.',
          },
        }
      }
      const knownInstallable = siteRow?.installable === true
      // Version compatibility, before any download: the harness denies a plugin whose
      // engines.dsh excludes the running version (2026-11-08: dsh-ops@0.4.4 went dark
      // after an app update). The site index carries the range, so this costs nothing.
      const runtime = runtimeVersionOf()
      if (siteRow?.engines && runtime.version && !satisfiesEngines(runtime.version, siteRow.engines)) {
        await recordFailure(args.name, chosen.version, 'incompatible-runtime')
        return {
          skipped: true,
          answer: {
            name: args.name,
            version: chosen.version,
            installable: false,
            reason: 'incompatible-runtime',
            runtime: runtime.version,
            enginesDsh: siteRow.engines,
            hint: `This version requires engines.dsh ${siteRow.engines}, which excludes the running dsh ${runtime.version}; the harness would refuse it at startup. Install a release whose engines.dsh admits ${runtime.version} instead (pass version).`,
          },
        }
      }
      // Ask the manager what the spec names before installing it: authoritative, and it
      // reports a refusal (not-found) instead of us guessing with HEAD requests.
      let inspection
      if (!knownInstallable && !prefetchedFast && settings.verifyInstall && typeof api.inspect === 'function' && !/^(git\+|github:)/.test(String(target.spec))) {
        try {
          inspection = await api.inspect(String(target.spec), { registry }, AbortSignal.timeout(Number(settings.inspectMs) || DEFAULTS.inspectMs))
        } catch {
          inspection = undefined
        }
        if (inspection?.status === 'refused' && inspection.problem === 'not-found') {
          await recordFailure(args.name, chosen.version, 'not-found')
          return {
            skipped: true,
            answer: {
              name: args.name,
              version: chosen.version,
              installable: false,
              reason: 'not-on-registry',
              checked: inspection.registries ?? undefined,
              hint: 'The manager could not find this spec in any registry; nothing was installed.',
            },
          }
        }
        if (inspection?.status === 'accepted') {
          if (inspection.registry) registry = String(inspection.registry).replace(/\/+$/, '')
          if (inspection.name && inspection.name !== args.name) spec = `${inspection.name}@${chosen.version}`
        }
      }
      // Fallback: the old HEAD probe, only when inspect is unavailable or inconclusive.
      if (!prefetchedFast && !inspection && settings.verifyInstall && !/^(git\+|github:)/.test(String(target.spec))) {
        const key = `${args.name}@${chosen.version}`
        probe = probeCache.get(key) ?? (await probeRegistry([args.name, ...aliases], chosen.version, registry))
        if (probe.verdict !== 'unknown') probeCache.set(key, probe)
        if (probe.verdict === 'absent') {
          return {
            skipped: true,
            answer: {
              name: args.name,
              version: chosen.version,
              installable: false,
              reason: 'not-on-registry',
              checked: probe.checked,
              hint: 'The market lists this package, but no npm registry serves that version; nothing was installed and the profile is unchanged.',
            },
          }
        }
        // Keep the mirror unless the probe found the package somewhere else entirely.
        if (probe.verdict === 'ok' && probe.registry && !/registry\.npmjs\.org/i.test(String(probe.registry))) registry = probe.registry
        // The index renamed a duplicate: install the package name kept in `title`.
        if (probe.verdict === 'ok' && probe.package && probe.package !== args.name) {
          spec = `${probe.package}@${chosen.version}`
        }
      }
      // Only npmjs serves this version and no local copy could be fetched: that path is slow
      // and, on this class of host, frequently TLS-broken (measured 14.7 s ending in
      // ERR_PNPM_META_FETCH_FAIL). Say so immediately instead of hanging the turn.
      const onlySlowRegistry = !prefetchedFast && probe?.verdict === 'ok'
        && /registry\.npmjs\.org/i.test(String(probe.registry ?? ''))
      if (onlySlowRegistry && args.force !== true) {
        await recordFailure(args.name, chosen.version, 'slow-registry')
        return {
          skipped: true,
          answer: {
            name: args.name,
            version: chosen.version,
            installable: false,
            reason: 'slow-registry',
            registry: probe.registry,
            hint: 'The fast mirror does not carry this version and only registry.npmjs.org does, which is slow and intermittently TLS-broken here, so nothing was installed. Pass force:true to try anyway, or pick a version the mirror serves.',
          },
        }
      }
      mark('probe', lap)
      lap = Date.now()
      const beforeProxied = activate === 'proxy' ? visibleToolNames() : undefined
      // Git sources: the manager aborts when its own probe to github.com exceeds 5 s, so
      // fetch the archive from the fastest mirror and install the extracted directory.
      let archiveUsed
      if (String(spec).startsWith('github:') || String(spec).startsWith('git+')) {
        const gh = parseGithubUrl(chosen.source?.url)
        const sha = String(chosen.source?.commit ?? '')
        if (gh && /^[0-9a-f]{40}$/i.test(sha)) {
          const archive = await raceArchive(gh.owner, gh.repo, sha).catch(() => null)
          if (archive) {
            try {
              // Install the tarball itself: pnpm then places it inside the profile, where
              // the profile's node_modules (and peer dependencies) are resolvable.
              const safe = String(args.name).replace(/[^a-z0-9._-]+/gi, '-')
              const tarball = join(cacheDir(), 'pkg', `${safe}-${sha.slice(0, 8)}.tgz`)
              await mkdir(join(cacheDir(), 'pkg'), { recursive: true })
              await writeFile(tarball, archive.buffer)
              spec = 'file:' + tarball.replace(/\\/g, '/')
              archiveUsed = { mirror: archive.url, ms: archive.ms, bytes: archive.buffer.length }
            } catch (error) {
              archiveUsed = { mirror: archive.url, error: String(error?.message ?? error) }
            }
          } else {
            archiveUsed = { error: 'no mirror answered within the budget' }
          }
        }
      }
      // The tarball was resolved above (prefetchedFast), so nothing to do here.
      let prefetched = prefetchedFast
      const beforeClientRows = Number(clientHalf().rows ?? 0)
      const beforeBundles = (await api.listBundles().catch(() => [])) ?? []
      const beforeToolsAll = visibleToolNames()
      const beforeSkills = await skillNameSet()
      const applied = await profileWrite(() => api.installBundle(spec, {
        enabled: activate !== 'session',
        registry,
        requestId: args.requestId,
      }))
      mark('install', lap)
      // What the install actually added: real bundle names, tools and skills.
      const known = new Set(beforeBundles.map((bundle) => bundle.name))
      const afterBundles = applied.application === 'applied' ? (await api.listBundles().catch(() => [])) ?? [] : []
      const addedBundles = afterBundles.filter((bundle) => !known.has(bundle.name)).map((bundle) => bundle.name)
      const addedSkills = [...(await skillNameSet())].filter((name) => !beforeSkills.has(name))
      const addedTools = [...visibleToolNames()].filter((name) => !beforeToolsAll.has(name))
      await rememberTools(addedBundles[0] ?? args.name, addedTools)
      // The bundle name is the only handle the manager accepts; remember the mapping.
      const realBundle = addedBundles[0] ?? args.name
      if (applied.application === 'applied' && realBundle !== args.name) installedUnder.set(args.name, realBundle)
      if (applied.application === 'restart-required') {
        await recordFailure(args.name, chosen.version, 'restart-required')
      }
      // The client graph updates asynchronously; give it a beat before deciding the install
      // contributed nothing at all.
      let addedClient = false
      if (applied.application === 'applied' && !addedTools.length && !addedSkills.length) {
        // Only a package that actually ships a browser half can move the client graph, so
        // wait for it only then: the unconditional 500 ms was pure latency for host-only
        // plugins (measured inside a 3.8 s load).
        const realName = addedBundles[0] ?? args.name
        let shipsClient = false
        try {
          const dir = profileDir()
          if (dir) {
            const manifest = JSON.parse(readFileSync(join(dir, 'node_modules', realName, 'package.json'), 'utf8'))
            shipsClient = Boolean(manifest?.dsh?.client)
          }
        } catch {}
        if (shipsClient) {
          await new Promise((resolve) => setTimeout(resolve, Number(settings.clientGraphWaitMs) || DEFAULTS.clientGraphWaitMs))
          addedClient = Number(clientHalf().rows ?? 0) > beforeClientRows
        }
      }
      const usable = addedTools.length > 0 || addedSkills.length > 0 || addedClient
      if (applied.application === 'applied' && !usable && args.keep !== true && (settings.strictUsable === true || args.strict === true)) {
        // It installed but brought nothing callable: roll it back instead of leaving weight.
        for (const name of addedBundles) await api.removeBundle(name).catch(() => {})
        await recordFailure(args.name, chosen.version, 'no-tools-or-skills')
        return {
          skipped: true,
          answer: {
            name: args.name,
            version: chosen.version,
            rejected: 'no-tools-or-skills',
            installedAs: addedBundles,
            hint: 'The package installed but exposes neither tools nor skills, so it was removed. Pass keep:true to keep it anyway, or pick another candidate.',
          },
        }
      }
      if (applied.error) {
        await recordFailure(args.name, chosen.version, String(applied.error?.code ?? 'install-failed'))
        // Neither applied nor restart-required means the profile is now inconsistent with
        // what the row claims. Undo it instead of leaving a half-install behind.
        if (applied.application !== 'applied' && applied.application !== 'restart-required') {
          for (const name of addedBundles) await profileWrite(() => api.removeBundle(name)).catch(() => {})
        }
      }
      let proxied = []
      if (activate === 'proxy' && applied.application === 'applied') {
        proxied = [...visibleToolNames()].filter((name) => !beforeProxied?.has(name))
        for (const name of proxied) hiddenTools.add(name)
        await saveHidden()
        await refreshRestrictions({ only: exec?.agent?.id })
        if (beforeProxied) watchLateRegistrations(beforeProxied)
      }
      return { skipped: false, applied, registry, probe, spec, proxied, archiveUsed, addedBundles, addedTools, addedSkills, addedClient, usable, prefetched }
    })()

    if (result.skipped) return result.answer

    const { applied } = result
    // A git spec has no @version suffix to strip; the market name is the only stable handle.
    const installedAs = /^(git+|github:|link:)/.test(String(result.spec)) ? args.name : result.spec.replace(/@[^@/]+$/, '')
    if (applied.application === 'applied' && activate === 'boot') await addPending({ name: installedAs, version: chosen.version, registry: result.registry })
    if (applied.application === 'applied') await addPool(installedAs)
    if (applied.application === 'applied' && activate === 'now') {
      loaded.add(installedAs)
      if (installedAs !== args.name) installedUnder.set(args.name, installedAs)
      await recordUsage(installedAs, 'load')
    }
    return {
      name: args.name,
      version: chosen.version,
      spec: result.spec,
      installedAs: installedAs === args.name ? undefined : installedAs,
      registry: result.registry,
      verified: result.probe?.verdict,
      activated: activate !== 'session',
      restartRequired: result.applied?.application === 'restart-required' ? true : undefined,
      prefetched: result.prefetched ? true : undefined,
      archive: result.archiveUsed,
      installedBundles: result.addedBundles?.length ? result.addedBundles : undefined,
      addedTools: result.addedTools?.length ? result.addedTools : undefined,
      addedSkills: result.addedSkills?.length ? result.addedSkills : undefined,
      addedClient: result.addedClient ? true : undefined,
      // Absence of a surface is not proof of uselessness: event handlers and self-mounted
      // widgets are invisible here. Reported, not acted on.
      surfaces: result.applied?.application === 'applied'
        ? {
            tools: result.addedTools?.length ?? 0,
            skills: result.addedSkills?.length ?? 0,
            client: result.addedClient ? 1 : 0,
            observed: Boolean(result.addedTools?.length || result.addedSkills?.length || result.addedClient),
          }
        : undefined,
      proxied: result.proxied?.length ? result.proxied : undefined,
      callWith: result.proxied?.length ? 'invoke' : undefined,
      proxiedSchemas: (result.proxied ?? [])
        .map((name) => (ctx.tools?.schemas?.() ?? []).find((schema) => schema.name === name))
        .filter(Boolean),
      promptImpact: activate === 'now'
        ? 'tool-set changed: the prompt prefix is rebuilt from the tool list until the route supports toolUpdate'
        : activate === 'proxy'
          ? (result.proxied?.length
            ? 'none: the plugin is active, but its tools are hidden from the model and run through action=invoke'
            : 'none: the plugin added no tools, so the visible tool set is unchanged')
          : 'none: installed only — enable it later with a fast load (no download, ~0.1-0.3 s) when you are ready to pay one prefix rebuild',
      application: applied.application,
      stage: applied.stage,
      enabled: applied.enabled,
      restartReason: applied.restartReason,
      warnings: applied.warnings ?? [],
      pendingBuilds: applied.pendingBuilds ?? [],
      error: applied.error?.code,
      diagnostic: applied.error?.diagnostic,
      phases,
      ms: Date.now() - started,
    }
  }

  // ---- residency ---------------------------------------------------------------
  // Community pattern, not a hand-written list (see CREDITS.md): protection belongs to
  // the profile's own base bundles, while "I use this often" is a computed property.
  //   base     — bundle.availability is not 'profile': hard-protected, no tool path can
  //              remove it (the same shape as dsh-hotswap's DEFAULT_PROTECTED entries).
  //   explicit — names listed in config.resident (kept for overrides and tests).
  //   auto     — decided by a local usage score with a 14-day half-life:
  //                score = 1.0*decayed(loads) + 0.3*decayed(manualEnables) + (base ? 1000 : 0)
  //              resident when score >= residentScore (default 3 ≈ three loads in two weeks).
  // Decay rather than raw counts is what popcon and browser permission prompts converged on:
  // recency matters more than the total.
  const HALF_LIFE_MS = Math.max(1, Number(settings.halfLifeDays) || DEFAULTS.halfLifeDays) * 86400000
  const usage = { packages: {} }
  let usageLoaded = false

  const usagePath = () => join(cacheDir(), 'usage.json')
  const pendingPath = () => join(cacheDir(), 'pending.json')
  const poolPath = () => join(cacheDir(), 'pool.json')

  // The auto-install pool: packages this tool fetched. Persisted so the grouping survives a
  // restart, and cleared on uninstall so a later manual install counts as the user's own.
  // Names of the skills currently visible to this process; used to tell whether an install
  // actually added something callable.
  const skillNameSet = async () => {
    try {
      const listed = await ctx.get('skills')?.list?.({})
      return new Set((listed ?? []).map((entry) => entry.name))
    } catch {
      return new Set()
    }
  }

  // Short memory of picks that did not work out, so ensure does not offer them again.
  const failedPath = () => join(cacheDir(), 'failed.json')

  const readFailed = async () => {
    try {
      const parsed = JSON.parse(await readFile(failedPath(), 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  const recordFailure = async (name, version, reason) => {
    const failed = await readFailed()
    failed[name] = { version, reason, at: Date.now() }
    try {
      await mkdir(cacheDir(), { recursive: true })
      await writeFile(failedPath(), JSON.stringify(failed))
    } catch {
      // the memory is advisory
    }
  }

  // A failure older than this is forgotten: the package may have shipped a fix.
  const failureIsFresh = (entry) => Boolean(entry) && Date.now() - (entry.at ?? 0) < 7 * 86400000

  // A package name, never an install spec: `file:...tgz`, `github:owner/repo#sha` and
  // `link:<path>` all reach addPool() as `installedAs`, and none of them can be released or
  // displayed as a plugin. Dropping them is the one migration this cache needs.
  const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
  const isPackageName = (value) => typeof value === 'string' && PACKAGE_NAME.test(value)

  const readPool = async () => {
    try {
      const parsed = JSON.parse(await readFile(poolPath(), 'utf8'))
      const raw = Array.isArray(parsed?.names) ? parsed.names : []
      const names = [...new Set(raw.filter(isPackageName))]
      if (names.length !== raw.length) {
        // Prune once, in place: the old entries were specs and can never match a bundle.
        await writePool(names)
      }
      return names
    } catch {
      return []
    }
  }

  const writePool = async (names) => {
    try {
      await mkdir(cacheDir(), { recursive: true })
      await writeFile(poolPath(), JSON.stringify({ names, at: Date.now() }))
    } catch {
      // the pool is bookkeeping; failing to persist it must not break an install
    }
  }

  const addPool = async (name) => {
    if (!isPackageName(name)) return
    const names = await readPool()
    if (!names.includes(name)) await writePool([...names, name])
  }

  const dropPool = async (name) => {
    const names = await readPool()
    if (names.includes(name)) await writePool(names.filter((item) => item !== name))
  }

  // Packages installed now but activated at the next plugin activation: the tool set changes
  // once, at a session boundary where no cache is warm yet.
  const readPending = async () => {
    try {
      const parsed = JSON.parse(await readFile(pendingPath(), 'utf8'))
      const rows = Array.isArray(parsed?.names) ? parsed.names : []
      return rows.map((item) => (typeof item === 'string' ? { name: item } : item))
    } catch {
      return []
    }
  }

  const writePending = async (names) => {
    try {
      await mkdir(cacheDir(), { recursive: true })
      await writeFile(pendingPath(), JSON.stringify({ names, at: Date.now() }))
    } catch {
      // the queue is advisory; failing to persist it must not break an install
    }
  }

  const addPending = async (entry) => {
    const rows = await readPending()
    const row = typeof entry === 'string' ? { name: entry } : entry
    if (!rows.some((item) => item.name === row.name)) await writePending([...rows, row])
  }

  const loadUsage = async () => {
    if (usageLoaded) return
    usageLoaded = true
    try {
      const parsed = JSON.parse(await readFile(usagePath(), 'utf8'))
      if (parsed?.packages && typeof parsed.packages === 'object') usage.packages = parsed.packages
    } catch {
      // first run, or an unreadable file: start empty instead of failing the call
    }
  }

  const saveUsage = async () => {
    try {
      await mkdir(cacheDir(), { recursive: true })
      await writeFile(usagePath(), JSON.stringify(usage))
    } catch {
      // usage is an optimisation; never let it break a real operation
    }
  }

  const recordUsage = async (name, kind) => {
    await loadUsage()
    const row = usage.packages[name] ?? { loads: [], enables: [] }
    const now = Date.now()
    if (kind === 'load') row.loads = [...(row.loads ?? []), now].slice(-120)
    else row.enables = [...(row.enables ?? []), now].slice(-120)
    row.lastUsedAt = now
    usage.packages[name] = row
    await saveUsage()
  }

  const decayed = (stamps) => {
    const now = Date.now()
    return (stamps ?? []).reduce((sum, at) => sum + Math.pow(0.5, Math.max(0, now - at) / HALF_LIFE_MS), 0)
  }

  const scoreOf = async (name, base) => {
    await loadUsage()
    const row = usage.packages[name]
    const score = (base ? 1000 : 0) + decayed(row?.loads) + decayed(row?.enables) * 0.3
    return Math.round(score * 100) / 100
  }

  // Resolved against the live bundle list, so a package removed by the user stops being
  // resident without any config edit.
  const residency = async (name, knownBundles) => {
    const bundles = knownBundles ?? ((await manager()?.listBundles().catch(() => [])) ?? [])
    const bundle = (bundles ?? []).find((item) => item.name === name)
    // Only an active non-profile bundle is structurally protected. A disabled built-in is
    // left alone entirely: it belongs to the composition, not to this tool.
    const base = Boolean(bundle) && bundle.availability !== 'profile' && bundle.enabled === true
    const explicit = new Set((settings.resident ?? []).map(String)).has(name)
    const score = await scoreOf(name, base)
    const auto = score >= (Number(settings.residentScore) || DEFAULTS.residentScore)
    const kind = base ? 'base' : explicit ? 'explicit' : auto ? 'auto' : 'none'
    return { resident: kind !== 'none', kind, score, installed: Boolean(bundle) }
  }

  // Only a structural (base) bundle is refused outright: removing it can be just as
  // unrecoverable as hotswap's host entries. A "resident by usage" package only gets a
  // warning and the operation still happens — the agent must be able to clean up.
  const baseRefusal = (name, action) => ({
    name,
    kept: true,
    reason: 'base',
    action,
    hint: `${name} is a base bundle of this profile, not a market plugin; ${action} was refused.`,
  })

  const unload = async (args) => {
    const api = requireManager()
    const real = realNameOf(args.name)
    const where = await residency(real)
    if (where.kind === 'base') return baseRefusal(args.name, 'unload')
    const result = await profileWrite(() => api.setBundleEnabled(real, false))
    if (result.error && real !== args.name) {
      // The alias may not have been used after all; fall back to the name as given.
      const direct = await api.setBundleEnabled(args.name, false)
      if (!direct.error) {
        loaded.delete(args.name)
        return { name: args.name, application: direct.application, enabled: direct.enabled, residentWarning: where.resident ? where.kind : undefined }
      }
    }
    loaded.delete(real)
    loaded.delete(args.name)
    // The alias mapping survives an unload: `release` unloads first and then removes, so
    // the removal still has to know which bundle name was really installed.
    return {
      name: args.name,
      unloadedAs: real === args.name ? undefined : real,
      application: result.application,
      enabled: result.enabled,
      error: result.error?.code,
      residentWarning: where.resident ? where.kind : undefined,
    }
  }

  const uninstall = async (args) => {
    const api = requireManager()
    const real = realNameOf(args.name)
    const where = await residency(real)
    if (where.kind === 'base') return baseRefusal(args.name, 'uninstall')
    const result = await profileWrite(() => api.removeBundle(real))
    await dropPool(real)
    // An archive install lives under the cache; drop it with the package so a 68 MB checkout
    // does not outlive the plugin.
    try {
      const { rm } = await import('node:fs/promises')
      const dir = join(cacheDir(), 'git')
      for (const entry of await (await import('node:fs/promises')).readdir(dir).catch(() => [])) {
        if (entry.startsWith(String(real).replace(/[^a-z0-9._-]+/gi, '-') + '-')) await rm(join(dir, entry), { recursive: true, force: true })
      }
    } catch {
      // best effort
    }
    loaded.delete(real)
    loaded.delete(args.name)
    installedUnder.delete(args.name)
    return {
      name: args.name,
      changed: result.changed,
      application: result.application,
      error: result.error?.code,
      residentWarning: where.resident ? where.kind : undefined,
    }
  }

  // dsh-hotswap's "restart a plugin without restarting dsh": toggling the row off and
  // on again is what makes a freshly installed module generation take effect.
  // A disable that cannot be undone leaves the tool unregistered, so the enable is retried
  // and any diagnostic is returned verbatim instead of being swallowed.
  const reload = async (args) => {
    const api = requireManager()
    const real = realNameOf(args.name)
    const off = await api.setBundleEnabled(real, false)
    if (off.error) {
      return { name: args.name, stage: 'disable', application: off.application, error: off.error.code, diagnostic: off.error.diagnostic }
    }
    let on = await api.setBundleEnabled(real, true)
    let retried = false
    if (on.error) {
      retried = true
      await new Promise((resolve) => setTimeout(resolve, 400))
      on = await api.setBundleEnabled(real, true)
    }
    return {
      name: args.name,
      reloadedAs: real === args.name ? undefined : real,
      stage: 'enable',
      application: on.application,
      enabled: on.enabled,
      restartReason: on.restartReason,
      error: on.error?.code,
      diagnostic: on.error?.diagnostic,
      retried,
      hint: on.error
        ? 'The bundle is still disabled. Fix the cause (most often an unparsable cordis.patch.yml such as an unquoted @scope value) and call reload again; plugin_manager set_bundle can also switch it back on.'
        : undefined,
    }
  }

  // A fresh process has nothing in memory, but a disk copy may already be usable; saying
  // "cached: false" there is misleading, so the origin is reported explicitly.
  // ---- hidden tools / proxy -------------------------------------------------
  // A newly enabled plugin adds tools to the model-visible list, which changes the prompt
  // prefix. Hide them per agent instead, and execute them from the host scope.
  const hiddenTools = new Set()
  const restrictions = new Map()
  const hiddenPath = () => join(cacheDir(), 'hidden.json')
  const toolMapPath = () => join(cacheDir(), 'toolmap.json')
  const toolMap = new Map()

  const loadToolMap = async () => {
    if (toolMap.size) return toolMap
    try {
      const parsed = JSON.parse(await readFile(toolMapPath(), 'utf8'))
      for (const [bundle, tools] of Object.entries(parsed?.map ?? {})) {
        if (Array.isArray(tools) && tools.length) toolMap.set(bundle, tools)
      }
    } catch {
      // no map yet
    }
    return toolMap
  }

  // Learn (or refresh) the tools a bundle owns.
  const rememberTools = async (bundle, tools) => {
    if (!bundle || !Array.isArray(tools) || !tools.length) return
    await loadToolMap()
    const merged = [...new Set([...(toolMap.get(bundle) ?? []), ...tools])]
    toolMap.set(bundle, merged)
    try {
      await mkdir(cacheDir(), { recursive: true })
      await writeFile(toolMapPath(), JSON.stringify({ map: Object.fromEntries(toolMap), at: Date.now() }))
    } catch {
      // the map is an optimisation
    }
  }

  const loadHidden = async () => {
    try {
      const parsed = JSON.parse(await readFile(hiddenPath(), 'utf8'))
      for (const name of parsed?.names ?? []) hiddenTools.add(name)
    } catch {
      // no mask on disk yet
    }
  }

  const saveHidden = async () => {
    try {
      await mkdir(cacheDir(), { recursive: true })
      await writeFile(hiddenPath(), JSON.stringify({ names: [...hiddenTools], at: Date.now() }))
    } catch {
      // the mask still works in memory
    }
  }

  const maskDiagnostics = []
  const installRestriction = (agent, liveNames) => {
    const known = liveNames ?? visibleToolNames()
    const names = [...hiddenTools].filter((name) => known.has(name))
    if (!names.length) return
    if (!agent?.ctx?.tools?.restrict) {
      maskDiagnostics.push({ agent: String(agent?.id ?? '?').slice(0, 8), skipped: 'no restrict on agent.ctx.tools' })
      return
    }
    try {
      restrictions.get(agent.id)?.()
    } catch {
      // a stale disposer is harmless
    }
    let pending = [...names]
    let denied = 0
    let lastError
    for (let attempt = 0; attempt < 4 && pending.length; attempt += 1) {
      try {
        restrictions.set(agent.id, agent.ctx.tools.restrict({ deny: pending }))
        denied = pending.length
        lastError = undefined
        break
      } catch (error) {
        lastError = String(error?.message ?? error)
        // The message lists every name the scope does not know; drop them and try the rest.
        const unknown = [...lastError.matchAll(/"([^"]+)"/g)].map((match) => match[1])
        const drop = new Set(unknown)
        const next = pending.filter((name) => !drop.has(name))
        if (!next.length || next.length === pending.length) break
        pending = next
      }
    }
    maskDiagnostics.push(denied
      ? { agent: String(agent.id).slice(0, 8), denied, skipped: names.length - denied || undefined }
      : { agent: String(agent.id).slice(0, 8), denied: 0, error: lastError?.slice(0, 160) })
  }

  const refreshRestrictions = async () => {
    const known = visibleToolNames()
    await loadToolMap()
    const owned = new Set([...toolMap.values()].flat())
    let pruned = false
    for (const name of [...hiddenTools]) {
      if (known.has(name)) continue
      // A name is only stale when no bundle claims it. An absence can be transient: a reload
      // unregisters a bundle's tools for a moment, and treating that as removal wiped the mask.
      if (owned.has(name)) continue
      hiddenTools.delete(name)
      pruned = true
    }
    if (pruned) await saveHidden()
    const registry = ctx.get('agents')
    for (const agent of registry?.list?.() ?? []) {
      // Dispose first: `installRestriction` returns early when nothing is masked, so an
      // unmask (unadopt) used to leave the previous restriction on every live agent. That is
      // why a cleared mask still looked applied until the plugin was reloaded.
      try {
        restrictions.get(agent.id)?.()
      } catch {
        // a stale disposer is harmless
      }
      restrictions.delete(agent.id)
      installRestriction(agent, known)
    }
  }

  // Union of the global view and every live agent view. The global view alone lists only
  // globally-registered tools — measured 23 against 76 for the agent view — so a bundle whose
  // rows register inside a preset scope looked like it owned nothing and adopt learned no map.
  const visibleToolNames = () => {
    const names = new Set((ctx.tools?.schemas?.() ?? []).map((schema) => schema.name))
    try {
      for (const agent of ctx.get('agents')?.list?.() ?? []) {
        for (const schema of ctx.tools?.schemas?.(agent) ?? []) names.add(schema.name)
      }
    } catch {
      // no agent registry: the global view is all we have
    }
    return names
  }

  // A plugin may register tools a moment after its bundle activates (async init). Re-scan a
  // few times so a late registration is hidden too instead of silently reaching the model.
  const reconcileProxied = async (baseline) => {
    const fresh = [...visibleToolNames()].filter((name) => !baseline.has(name) && !hiddenTools.has(name))
    if (!fresh.length) return
    for (const name of fresh) hiddenTools.add(name)
    await saveHidden()
    await refreshRestrictions()
  }

  const watchLateRegistrations = (baseline) => {
    for (const delay of [1200, 3500, 7000]) {
      const timer = setTimeout(() => { void reconcileProxied(baseline) }, delay)
      if (typeof timer.unref === 'function') timer.unref()
    }
  }

  // Execute through the proxy: the host scope is not restricted, so a tool hidden from
  // the agent stays callable here (verified: restrict needs agent.ctx, execute does not).
  const invoke = async (args, exec) => {
    const name = String(args.tool ?? '')
    if (!name) throw new Error('tool is required for invoke')
    if (name === 'lazy_plugin') throw new Error('refusing to invoke the proxy itself')
    const payload = args.arguments ?? {}
    const callId = exec?.callId ? String(exec.callId) + '-sub' : 'sub-' + Date.now()
    const signal = exec?.signal ?? new AbortController().signal
    const agent = exec?.agent ?? ctx.get('agents')?.list?.()[0]
    const runOnce = async (withAgent) => {
      const batch = await ctx.tools.execute({
        calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(payload) }],
        signal,
        ...(withAgent && agent ? { agent } : {}),
        maxParallelToolCalls: 1,
      })
      return batch?.results?.[0]?.result
    }
    let settled
    try {
      // Host scope first: a masked tool is only executable without an agent, which is what
      // makes proxy mode work at all.
      settled = await runOnce(false)
      if (settled?.isError && /unknown tool/i.test(String(settled.error?.message ?? '')) && agent) {
        settled = await runOnce(true)
      }
    } catch (error) {
      return { tool: name, error: String(error?.message ?? error), hint: 'the runtime rejected the batch before running it' }
    }
    if (!settled) return { tool: name, error: 'no result returned for this call' }
    if (settled.isError) {
      const code = settled.error?.info?.code
      return {
        tool: name,
        error: settled.error?.message ?? String(settled.error ?? 'tool failed'),
        code,
        // Only a resolution failure deserves the loading hint; a tool that ran and failed
        // (missing API key, bad path) must keep its own message and nothing else.
        hint: code === 'UNKNOWN_TOOL' || code === 'TOOL_NOT_FOUND'
          ? 'that name is not callable: run list to see which bundles are loaded, then load the one that owns it'
          : undefined,
      }
    }
    return { tool: name, value: settled.value }
  }

  // Trigger 2 evidence. Three counters, deliberately distinct:
  //   panelPings      — client-sourced calls that actually PASSED the throttle (refreshed).
  //   clientRequests  — every client-sourced call, throttled ones included (a throttled
  //                     call still proves the page ran client.js).
  //   browserPings    — client-sourced calls whose headers prove a real browser made them
  //                     (Sec-Fetch-Mode + Mozilla UA + Referer); a `curl ?src=mount` probe
  //                     cannot increment this.
  // A call without `?src=` (a manual curl) counts in none of them.
  let panelPings = 0
  let clientRequests = 0
  let lastPanelPingAt = null
  let lastPanelPingSource = null
  let lastRouteCallAt = null
  let lastRouteCallSource = null

  const browserPings = { count: 0, at: null, source: null, fingerprint: null }

  const fingerprintOf = (req) => {
    const head = (name) => {
      const value = req?.headers?.[name]
      return typeof value === 'string' ? value.slice(0, 160) : undefined
    }
    const referer = head('referer')
    const secFetchMode = head('sec-fetch-mode')
    const userAgent = head('user-agent')
    return {
      referer,
      secFetchMode,
      userAgent,
      // A same-origin `fetch()` from the page always carries Sec-Fetch-Mode and a real
      // browser user agent; curl sends neither.
      fromBrowser: Boolean(secFetchMode) && /^Mozilla\//.test(userAgent ?? ''),
    }
  }

  // Self-heal for a known upstream gap: `ClientModuleRegistry.pkgMeta` caches the verdict
  // "this package declares no client half" and has no invalidation path (grep pkgMeta in
  // @deepseek-ai/dsh-client-modules/lib/index.js: only new/get/set, never delete). A host
  // that started before `dsh.client` was added therefore keeps answering `null` forever,
  // and no page will ever load `client.js`.
  //
  // Dropping that one stale key and then marking the row dirty lets the registry run its own
  // `flush()`: `flush` calls `processOne` AND `compose()` AND `notifyGraphChanged()`, so the
  // published graph (and its `rev`) really changes. Calling `processOne` directly is NOT
  // enough — it updates `table` (78 → 79) while `composed`/`rev` stay stale, which is exactly
  // what the first version of this repair produced.
  //
  // Idempotent: once the row is in the graph this is a no-op. Never called from a GET.
  let lastRepair = null
  const ensureClientRow = (reason = 'manual') => {
    const modules = ctx.get('clientModules')
    if (!modules) return (lastRepair = { at: new Date().toISOString(), reason, attempted: false, why: 'clientModules service not active' })
    const ids = (modules.graph?.()?.entries ?? []).map((entry) => entry?.id)
    if (ids.includes(SELF_PACKAGE)) {
      return (lastRepair = { at: new Date().toISOString(), reason, attempted: false, why: 'already in graph' })
    }
    const loader = ctx.get('loader') ?? ctx.loader
    const raw = typeof loader?.entries === 'function' ? loader.entries() : []
    const rows = Array.isArray(raw) ? raw : [...(raw ?? [])]
    const row = rows.find((entry) => entry?.options?.name === SELF_PACKAGE)
    if (!row) {
      return (lastRepair = { at: new Date().toISOString(), reason, attempted: false, why: 'loader row not found', rows: rows.length })
    }
    const baseUrl = row.parent?.tree?.ctx?.baseUrl
    if (!baseUrl) return (lastRepair = { at: new Date().toISOString(), reason, attempted: false, why: 'loader row has no resolution base URL' })
    const sourceKey = `${baseUrl}\u0000${SELF_PACKAGE}`
    const cached = modules.pkgMeta?.get?.(sourceKey)
    const clearedStaleNull = cached === null
    if (clearedStaleNull) modules.pkgMeta.delete(sourceKey)

    const snapshot = () => {
      const graph = modules.graph?.()
      return { rows: graph?.entries?.length, rev: graph?.rev }
    }
    const before = snapshot()
    const table = (() => {
      try {
        const records = [...(modules.table?.values?.() ?? [])]
        const mine = records.filter((record) => record?.loaderName === SELF_PACKAGE || record?.entry?.id === SELF_PACKAGE)
        return {
          size: records.length,
          mine: mine.map((record) => ({ loaderName: record.loaderName, sourceKey: record.sourceKey, entry: record.entry })),
        }
      } catch (error) {
        return { error: String(error?.message ?? error) }
      }
    })()

    const errors = []
    try {
      // Force `processOne` to report a change. With the row already in `table` under the same
      // sourceKey, `reconcilePackage` returns false, so `flush` returns before `compose()` and
      // the published graph stays stale forever (the exact state the first repair attempt left
      // behind). Dropping the record makes reconcile rebuild it and `flush` then composes.
      if (table.mine?.length > 0) modules.table?.delete?.(SELF_PACKAGE)
      modules.dirty?.add?.(SELF_PACKAGE)
      modules.flush?.((error) => errors.push(String(error?.message ?? error)))
    } catch (error) {
      errors.push(String(error?.message ?? error))
    }

    // `flush()` returns early when `processOne` reports no change — exactly the state a
    // previous direct `processOne` leaves behind (table updated, `composed` stale, no
    // `compose()` call). Compose unconditionally: entries come straight from `table`, so a
    // row that is in the table but not in the graph is repaired here, and `rev` is a hash of
    // `{entries, batches}` so it necessarily changes when the row appears.
    let compose = null
    try {
      const composed = modules.compose?.()
      if (composed && typeof composed === 'object') {
        modules.composed = composed
        modules.notifyGraphChanged?.()
        const ids = (composed.entries ?? []).map((entry) => entry?.id)
        compose = {
          rows: ids.length,
          rev: composed.rev,
          present: ids.includes(SELF_PACKAGE),
          tailIds: ids.slice(-3),
        }
      } else {
        compose = { error: 'compose() returned no object' }
      }
    } catch (error) {
      compose = {
        error: String(error?.message ?? error),
        failures: Array.isArray(error?.failures) ? error.failures.map((failure) => String(failure?.message ?? failure)) : undefined,
      }
    }

    const after = snapshot()
    const inGraph = (modules.graph?.()?.entries ?? []).some((entry) => entry?.id === SELF_PACKAGE)
    lastRepair = {
      at: new Date().toISOString(),
      reason,
      attempted: true,
      // `attempted:false` + `why:'already in graph'` elsewhere in this function is an
      // idempotent no-op, not a failure.
      cachedBefore: cached === undefined ? 'none' : cached === null ? 'null' : 'resolved',
      clearedStaleNull,
      inGraphAfter: inGraph,
      graphRev: after.rev,
      rows: after.rows,
      before,
      table,
      compose,
      errors: errors.length > 0 ? errors : undefined,
      // EXIT CONDITION: this whole repair exists only because the upstream registry caches a
      // "no client half" verdict with no invalidation path. Delete `ensureClientRow` (and the
      // boot timer / repair routes that call it) as soon as @deepseek-ai/dsh-client-modules
      // keys `pkgMeta` with the manifest mtime/size, or exposes `invalidate()` — see
      // _tmp/panel-trigger/UPSTREAM-ISSUE.md.
      upstream: 'workaround: client-modules pkgMeta has no invalidation path; remove when upstream fixes it',
    }
    return lastRepair
  }

  // Why is this package not in the composed graph? Read the clientModules registry's own
  // private state (the same fields its scan writes) instead of guessing which condition
  // skipped the row: loader row → source → pkgMeta → table.
  const clientScanDiagnosis = (modules) => {
    try {
      const loader = ctx.get('loader') ?? ctx.loader
      const rows = typeof loader?.entries === 'function' ? loader.entries() : []
      const matches = (value) => String(value ?? '').includes('lazy-plugins')
      return {
        loaderRows: rows.filter((entry) => matches(entry?.options?.name)).map((entry) => ({
          name: entry.options?.name,
          disabled: Boolean(entry.disabled),
          hasFiber: Boolean(entry.fiber),
          baseUrl: entry.parent?.tree?.ctx?.baseUrl,
        })),
        localLoaderNames: rows
          .map((entry) => String(entry?.options?.name ?? ''))
          .filter((name) => name.startsWith('@local/')),
        sources: [...(modules.sources?.values?.() ?? [])]
          .filter((source) => matches(source?.loaderName) || matches(source?.packageName))
          .map((source) => ({
            loaderName: source.loaderName,
            packageName: source.packageName,
            clientPath: source.meta?.clientPath,
          })),
        sourceCount: modules.sources?.size,
        tableHas: Boolean(modules.table?.has?.(SELF_PACKAGE)),
        tableSize: modules.table?.size,
        pkgMeta: [...(modules.pkgMeta?.keys?.() ?? [])]
          .filter((key) => matches(key))
          .map((key) => ({ key, value: JSON.stringify(modules.pkgMeta.get(key))?.slice(0, 400) })),
        dirty: [...(modules.dirty ?? [])].filter((name) => matches(name)),
        // Reference rows that ship a client half: one npm-installed profile plugin and one
        // bundled app plugin. Which of them appears tells us whether the skip condition is
        // about this package or about profile rows in general.
        notifyInGraph: (modules.graph?.()?.entries ?? []).some((entry) => entry?.id === '@goodandready/dsh-plugin-notify'),
        remoteWebUiInGraph: (modules.graph?.()?.entries ?? []).some((entry) => entry?.id === '@linxin666/dsh-remote-web-ui'),
        graphIdsSample: (modules.graph?.()?.entries ?? []).slice(0, 6).map((entry) => entry?.id),
      }
    } catch (error) {
      return { error: String(error?.message ?? error) }
    }
  }

  // Is the browser half composed into the boot graph this host serves? That is the
  // host-side fact behind "the page will load client.js": clientModules scans
  // `dsh.client` + `exports['./client']` and exposes the served row through `graph()`.
  const clientHalf = () => {
    try {
      const modules = ctx.get('clientModules')
      if (!modules) return { available: false, reason: 'clientModules service not active' }
      // Repair a stale "no client half" verdict first (no-op once the row is in the graph).
      // (no side effect on GET — the repair is explicit, see the /repair-client route)
      // `graph()` returns `{ rev, release, entries, batches }` — `entries` is the row list
      // served as `window.__DSH_BOOT__` (see @deepseek-ai/dsh-client-modules compose()).
      const graph = modules.graph?.()
      if (!graph || typeof graph !== 'object') {
        return { available: true, inGraph: false, reason: 'graph() returned no object', raw: String(graph).slice(0, 200) }
      }
      const entries = Array.isArray(graph.entries) ? graph.entries : []
      const self = entries.find((entry) => entry?.id === SELF_PACKAGE)
      const half = {
        available: true,
        inGraph: Boolean(self),
        rows: entries.length,
        graphRev: graph.rev,
        url: self?.url,
        rev: self?.rev,
        clientPath: modules.clientPath?.(SELF_PACKAGE),
      }
      // The diagnosis only matters while the row is missing.
      if (!half.inGraph) half.diagnosis = clientScanDiagnosis(modules)
      // Result of the last explicit/startup repair attempt (GET stays read-only).
      if (lastRepair) half.lastRepair = lastRepair
      return half
    } catch (error) {
      return { available: false, error: String(error?.message ?? error) }
    }
  }

  const indexState = async () => {
    const url = pickIndexUrl()
    if (!url) return { url: null }
    const memory = indexCache.get(url)
    const onDisk = memory ? null : await readDisk(url)
    const served = memory ?? onDisk
    return {
      url,
      cached: Boolean(served),
      from: memory ? 'memory' : onDisk ? 'disk' : 'none',
      ageMs: served ? Date.now() - served.at : undefined,
      checkedAt: served?.checkedAt ? new Date(served.checkedAt).toISOString() : undefined,
      source: served?.source,
      etag: served?.etag,
      mirrors: (settings.indexMirrors ?? []).length,
      timeoutMs: Number(settings.fetchTimeoutMs) || DEFAULTS.fetchTimeoutMs,
      refreshIntervalMs: Number(settings.refreshIntervalMs) || DEFAULTS.refreshIntervalMs,
      // Client-side trigger evidence (see `client.js`).
      panelPings, // client-sourced calls that passed the throttle (= one index refresh)
      clientRequests, // every client-sourced call, throttled ones included
      browserPings: browserPings.count, // header-verified browser calls; curl cannot fake these
      lastBrowserPingAt: browserPings.at ? new Date(browserPings.at).toISOString() : undefined,
      lastBrowserPingSource: browserPings.source ?? undefined,
      lastBrowserPingFingerprint: browserPings.fingerprint ?? undefined,
      lastPanelPingAt: lastPanelPingAt ? new Date(lastPanelPingAt).toISOString() : undefined,
      lastPanelPingSource: lastPanelPingSource ?? undefined,
      // Any call to the refresh route, with or without `?src=` (a manual curl lands here).
      lastRouteCallAt: lastRouteCallAt ? new Date(lastRouteCallAt).toISOString() : undefined,
      lastRouteCallSource: lastRouteCallSource ?? undefined,
      // Host-side answer to "will the page load client.js at all?".
      clientHalf: clientHalf(),
      panelThrottleMs: Number(settings.panelThrottleMs) || DEFAULTS.panelThrottleMs,
    }
  }

  // "Optimise the harness as it is now", not just install/uninstall: measure what the
  // profile actually costs (tool schema bytes ≈ prompt tokens), what was never used since
  // it was installed, and what the loader itself is spending on network.
  // Tune the plugin manager's own knobs through the sanctioned editor (validated, persisted,
  // reconciled). Only the fields this plugin has an opinion about are reachable.
  const TUNABLE = new Set(['githubConnectionTimeoutMs', 'inspectTimeoutMs', 'registry', 'fallbackRegistries', 'lockWaitMs', 'idleTimeoutMs'])

  const tune = async (args) => {
    const editor = ctx.get('configEditor')
    if (!editor?.entries || !editor?.edit) throw new Error('configEditor is unavailable in this profile')
    const entries = editor.entries() ?? []
    const describe = (entry) => String(entry?.options?.name ?? entry?.name ?? entry?.patchId ?? entry?.id ?? '')
    if (!args.key) {
      return {
        entries: entries.map((entry) => describe(entry)).slice(0, 40),
        tunable: [...TUNABLE],
      }
    }
    const key = String(args.key)
    if (!TUNABLE.has(key)) throw new Error(`key not tunable: ${key} (allowed: ${[...TUNABLE].join(', ')})`)
    const candidates = entries.filter((entry) => describe(entry).includes('plugin-manager'))
    if (!candidates.length) throw new Error('plugin-manager entry not found: ' + entries.map(describe).join(', ').slice(0, 300))
    const failures = []
    for (const target of candidates) {
      try {
        await editor.edit(target, (current, inherited) => ({ ...(inherited ?? {}), ...(current ?? {}), [key]: args.value }))
        return { ok: true, key, value: args.value, target: describe(target) }
      } catch (error) {
        failures.push(`${describe(target)}: ${String(error?.message ?? error)}`)
      }
    }
    throw new Error('no plugin-manager entry accepted the write: ' + failures.join(' | ').slice(0, 400))
  }

  // Newest published version of a package whose engines.dsh admits the runtime. Only
  // called for the (usually zero or one) incompatible rows, so the extra packument
  // request never touches the hot path.
  const compatibleVersionOf = async (packageName, runtimeVersion) => {
    try {
      const url = 'https://registry.npmmirror.com/' + String(packageName).replace('/', '%2f')
      const response = await fetch(url, {
        headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
        signal: AbortSignal.timeout(4000),
      })
      if (!response.ok) return undefined
      const document = await response.json()
      const versions = Object.keys(document?.versions ?? {})
      const fitting = versions.filter((version) => {
        const range = document.versions[version]?.engines?.dsh
        // No engines declaration means the harness accepts it, so it is a candidate.
        return !range || satisfiesEngines(runtimeVersion, range)
      })
      if (!fitting.length) return undefined
      const best = fitting.reduce((top, version) => (compareVersions(version, top) > 0 ? version : top), fitting[0])
      return { version: best, enginesDsh: document.versions[best]?.engines?.dsh, source: 'npmmirror' }
    } catch {
      return undefined
    }
  }
  const FAST_REGISTRY = 'https://registry.npmmirror.com'

  // Newest version worth installing: not deprecated, still a bundle, and accepted by the
  // running DSH version. Prereleases are only considered when the installed version is one,
  // so a stable install never jumps onto a nightly by accident.
  const bestVersionOf = (list, installed) => {
    if (list?.status !== 'listed') return { refused: list }
    const installedIsPre = /-/.test(String(installed ?? ''))
    const usable = (list.versions ?? []).filter((row) => {
      if (row.deprecated) return false
      if (row.bundle === false) return false
      if (row.incompatible) return false
      if (row.prerelease && !installedIsPre) return false
      return true
    })
    return { version: usable[0]?.version, considered: list.versions?.length ?? 0, skipped: (list.versions?.length ?? 0) - usable.length }
  }

  // Dry run: what could be updated, and why something cannot.
  // The site publishes the same document next to the index (generated by its crawl, across
  // the whole catalogue). Prefer that copy, fall back to the one bundled with this package,
  // and never block on the fetch.
  const domainsRemotePath = () => join(cacheDir(), 'plugin-domains.json')
  let domainsRemote
  let domainsRemoteBuilding

  const domainsUrlOf = (indexUrl) => {
    try {
      const url = new URL(indexUrl)
      url.pathname = url.pathname.replace(/\/index\.[a-z]{2}\.json$/i, '/plugin-domains.json')
      return url.toString()
    } catch {
      return null
    }
  }

  const refreshDomains = (indexUrl) => {
    if (domainsRemoteBuilding) return domainsRemoteBuilding
    const source = domainsUrlOf(indexUrl)
    if (!source) return undefined
    domainsRemoteBuilding = fetch(source, { signal: AbortSignal.timeout(Number(settings.bodyTimeoutMs) || DEFAULTS.bodyTimeoutMs) })
      .then((response) => (response.ok ? response.json() : undefined))
      .then(async (document) => {
        if (document?.format !== 'dsh-plugin-domains') return undefined
        domainsRemote = { ...document, fetchedAt: Date.now() }
        try {
          await mkdir(cacheDir(), { recursive: true })
          await writeFile(domainsRemotePath(), JSON.stringify(domainsRemote))
        } catch {
          // disk copy is an optimisation
        }
        return domainsRemote
      })
      .catch(() => undefined)
      .finally(() => {
        domainsRemoteBuilding = undefined
      })
    return domainsRemoteBuilding
  }

  // Non-blocking: bundled copy first, remote refresh in the background.
  const domainsLive = (indexUrl) => {
    if (domainsRemote) return domainsRemote
    try {
      const cached = JSON.parse(readFileSync(domainsRemotePath(), 'utf8'))
      if (cached?.format === 'dsh-plugin-domains') {
        domainsRemote = cached
        return cached
      }
    } catch {
      // no remote copy yet
    }
    void refreshDomains(indexUrl)
    return undefined
  }

  // Read-only view of the verified domain library. No network: the file ships with the
  // plugin and the names were checked against this runtime when it was built.
  const DOMAIN_ALIASES = {
    video: 'media-vision',
    image: 'media-vision',
    voice: 'media-voice',
    pdf: 'data-docs',
    doc: 'data-docs',
    docs: 'data-docs',
    sheet: 'data-office',
    excel: 'data-office',
    office: 'data-office',
    chart: 'data-analysis',
    db: 'data-analysis',
    crawl: 'connect-web',
    browser: 'connect-web',
    deploy: 'dev-runtime',
    test: 'dev-runtime',
    translate: 'enhance-models',
    session: 'enhance-session',
    context: 'enhance-memory',
    notes: 'enhance-memory',
    notify: 'connect-im',
    copywriting: 'agent-skills',
    skill: 'agent-skills',
  }

  const readTrainingSamples = async (limit) => {
    try {
      const raw = await readFile(trainingPath(), 'utf8')
      const lines = raw.split('\n').filter(Boolean)
      const out = []
      for (const line of lines.slice(-limit)) {
        try { out.push(JSON.parse(line)) } catch { /* skip a torn line */ }
      }
      return out
    } catch {
      return []
    }
  }

  // Replay the recorded candidate sets through a cheap scorer and report top-1 agreement.
  const shadow = async (args = {}) => {
    const limit = Math.min(Math.max(Number(args.samples) || 100, 5), 500)
    const samples = (await readTrainingSamples(limit)).filter((row) => row?.candidates?.length)
    if (!samples.length) return { samples: 0, hint: 'no judged decisions logged yet; use ensure/suggest with judge first' }
    // Same text source as production: the sidecar when the site publishes it. Scoring the
    // recorded (truncated) descriptions would measure a corpus nobody uses.
    const descriptionMap = await loadDescriptionMap().catch(() => new Map())
    const docs = []
    const seen = new Set()
    for (const sample of samples) {
      for (const candidate of sample.candidates) {
        if (!candidate?.name || seen.has(candidate.name)) continue
        seen.add(candidate.name)
        docs.push({ id: candidate.name, text: [candidate.name, plainText(candidate.title), descriptionMap.get(candidate.name) ?? plainText(candidate.description)].filter(Boolean).join(' ') })
      }
    }
    const index = buildBm25Index(docs)
    const engine = String(args.engine ?? 'bm25')
    let embed = null
    const vectorByName = new Map()
    if (engine === 'embedding') {
      embed = await encoderOf()
      if (!embed) return { engine, samples: 0, hint: 'encoder unavailable (onnxruntime-node or the model file is missing)' }
      // One pass over the unique candidate names: 42 samples x 20 candidates is ~800 texts.
      for (const doc of docs) {
        try { vectorByName.set(doc.id, await embed.embedOne(doc.text)) } catch { /* skip */ }
      }
    }
    let agree = 0
    let counted = 0
    // A retrieval scorer cannot say "none", so the two cases are measured separately:
    // agreement where the teacher named a plugin, and refusals where it did not.
    let pickedCases = 0
    let pickedAgree = 0
    let noneCases = 0
    let noneRefused = 0
    let falsePositives = 0
    const disagreements = []
    const samplesScored = []
    for (const sample of samples) {
      const names = sample.candidates.map((candidate) => candidate.name)
      let ranked
      let topScore
      if (engine === 'embedding') {
        const needVector = await embed.embedOne('为这个句子生成表示以用于检索相关文章：' + sample.need)
        ranked = names
          .filter((name) => vectorByName.has(name))
          .map((name) => ({ id: name, score: cosine(needVector, vectorByName.get(name)) }))
          .sort((a, b) => b.score - a.score)
        topScore = ranked[0]?.score
      } else {
        const { hits } = bm25Search(index, sample.need, { limit: 20 })
        ranked = hits.filter((hit) => names.includes(hit.id))
      }
      const ours = ranked[0]?.id
      const teacher = sample.pick ?? null
      if (teacher === undefined) continue
      counted += 1
      if (topScore !== undefined) samplesScored.push({ need: sample.need, teacher, ours: ranked[0]?.id ?? null, topScore })
      if (teacher === null) {
        noneCases += 1
        if (!ours) noneRefused += 1
        else falsePositives += 1
      } else {
        pickedCases += 1
        if (ours === teacher) pickedAgree += 1
      }
      if (ours === teacher) agree += 1
      else if (disagreements.length < 10) disagreements.push({ need: sample.need, teacher, bm25: ours ?? null, confidence: sample.confidence })
    }
    return {
      engine,
      samples: counted,
      agreement: counted ? Math.round((agree / counted) * 1000) / 1000 : null,
      agreementOnPicked: pickedCases ? Math.round((pickedAgree / pickedCases) * 1000) / 1000 : null,
      pickedCases,
      noneCases,
      noneRefused,
      falsePositives,
      disagreements,
      thresholdSweep: samplesScored.length
        ? [0.5, 0.55, 0.6, 0.65, 0.7].map((t) => {
            const accepted = samplesScored.filter((row) => row.topScore >= t)
            const right = accepted.filter((row) => row.teacher === row.ours)
            const pickedNone = accepted.filter((row) => row.teacher === null)
            const refusedNone = samplesScored.filter((row) => row.topScore < t && row.teacher === null).length
            return { t, accepted: accepted.length, correct: right.length, accuracy: accepted.length ? Math.round((right.length / accepted.length) * 1000) / 1000 : null, wrongInstalls: pickedNone.length, noneRefused: refusedNone }
          })
        : undefined,
      note: 'teacher = the model verdict recorded at judge time; bm25 sees the same candidate list',
    }
  }

  // Baseline for the shadow comparison: replay real needs through recall + judge, which logs
  // (need, candidate list, teacher pick). `shadow` then measures a cheap scorer against it.
  const baseline = async (args = {}) => {
    const want = Math.min(Math.max(Number(args.samples) || 20, 1), 200)
    const concurrency = Math.min(Math.max(Number(args.concurrency) || 4, 1), 8)
    let rows = []
    try {
      const raw = await readFile(corpusPath('positives'), 'utf8')
      rows = raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch {
      rows = []
    }
    if (!rows.length) return { samples: 0, hint: 'run action=corpus first' }
    const start = Number(args.offset) || 0
    const slice = rows.slice(start, start + want)
    let done = 0
    let failed = 0
    let lastError
    let emptyRecalls = 0
    const queue = [...slice]
    const worker = async () => {
      for (;;) {
        const row = queue.shift()
        if (!row) return
        try {
          const recalled = await recallViaSelect(row.need, undefined, 8)
          const pool = recalled?.entries ?? []
          if (!pool.length) {
            emptyRecalls += 1
            failed += 1
            continue
          }
          await llmJudge(row.need, pool)
          done += 1
        } catch (error) {
          lastError = String(error?.message ?? error).slice(0, 200)
          failed += 1
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker))
    return { samples: done, failed, emptyRecalls, lastError, nextOffset: start + slice.length, file: trainingPath() }
  }

  const repairExec = async (args = {}) => {
    const tmp = process.env.TEMP || process.env.TMP || join(homedir(), 'AppData', 'Local', 'Temp')
    const dryRun = args.dryRun === true
    let names = []
    try {
      names = (await readdir(tmp)).filter((name) => name.startsWith('dsh-ops-niu-exec-'))
    } catch (error) {
      return { ok: false, step: 'list', tmp, error: String(error?.message ?? error) }
    }
    const report = []
    let removed = 0
    let bytes = 0
    for (const name of names) {
      const target = join(tmp, name)
      let size = 0
      try {
        const stat = await lstat(target)
        size = stat.size
      } catch { /* already gone */ }
      report.push({ name, size })
      if (dryRun) continue
      try {
        await rm(target, { recursive: true, force: true, maxRetries: 3 })
        removed += 1
        bytes += size
      } catch (error) {
        report[report.length - 1].error = String(error?.message ?? error).slice(0, 120)
      }
    }
    return {
      ok: true,
      tmp,
      dryRun,
      trees: names.length,
      removed,
      bytes,
      kept: report.filter((row) => row.error),
      next: dryRun ? 'call again without dryRun to delete them' : 'retry ops_bash; the executor can be prepared again',
    }
  }

  const corpus = async (args) => {
    if (args.status === true) {
      const files = {}
      for (const kind of ['positives', 'none']) {
        try { files[kind] = (await readFile(corpusPath(kind), 'utf8')).trim().split('\n').filter(Boolean).length } catch { files[kind] = 0 }
      }
      return { dir: corpusDir(), samples: files }
    }
    if (args.background === true) {
      const requestId = 'corpus-' + Date.now().toString(36)
      backgroundJobs.set(requestId, buildCorpus(args).then((result) => ({ ok: true, result })).catch((error) => ({ ok: false, error: String(error?.message ?? error) })))
      return { requestId, hint: 'call action=wait with this requestId to collect the batch' }
    }
    return buildCorpus(args)
  }

  // Fast ranked retrieval the model can call before deciding anything.
  // Probe once per process: is a local encoder usable at all?
  let embeddingProbe
  const embeddingStatus = async () => {
    if (embeddingProbe) return embeddingProbe
    let runtime
    try {
      runtime = await import('onnxruntime-node')
    } catch {
      runtime = undefined
    }
    const modelPath = new URL('./models/bge-small-zh.onnx', import.meta.url)
    const modelFile = decodeURIComponent(modelPath.pathname).replace(/^\/([A-Za-z]:)/, '$1')
    const modelPresent = existsSync(modelFile)
    embeddingProbe = {
      available: Boolean(runtime) && modelPresent,
      runtime: runtime ? 'onnxruntime-node' : undefined,
      modelPath: modelFile,
      modelPresent,
      install: 'pnpm add onnxruntime-node && place bge-small-zh.onnx in <package>/models/',
    }
    return embeddingProbe
  }

  // ---- embedding matrix -----------------------------------------------------------
  let encoderPromise
  const encoderOf = async () => {
    if (encoderPromise) return encoderPromise
    const modelDir = new URL('./models/', import.meta.url)
    const model = decodeURIComponent(new URL('bge-small-zh.onnx', modelDir).pathname).replace(/^\/([A-Za-z]:)/, '$1')
    const vocab = decodeURIComponent(new URL('vocab.txt', modelDir).pathname).replace(/^\/([A-Za-z]:)/, '$1')
    encoderPromise = createEncoder(model, vocab).catch(() => undefined)
    return encoderPromise
  }

  let matrixCache
  const matrixPath = (key) => join(cacheDir(), `embeddings-${key}.f32`)
  const loadMatrix = async (count, dims) => {
    try {
      const buffer = await readFile(matrixPath(`${count}-${descriptions.sidecarAt ?? 0}`))
      const floats = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
      if (floats.length === count * dims) return floats
    } catch {
      // no cache yet
    }
    return undefined
  }

  let building = false
  const buildMatrix = async (document) => {
    if (building) return undefined
    building = true
    try {
      const encoder = await encoderOf()
      if (!encoder) return undefined
      const descriptionMap = await loadDescriptionMap().catch(() => new Map())
      const docs = (document?.plugins ?? []).map((plugin) => ({ id: plugin.name, text: [plugin.name, plainText(plugin.title), descriptionMap.get(plugin.name) ?? plainText(plugin.description)].filter(Boolean).join(' ').slice(0, 400) }))
      const started = Date.now()
      const dims = 512
      const matrix = new Float32Array(docs.length * dims)
      for (let i = 0; i < docs.length; i += 1) {
        const vector = await encoder.embedOne(docs[i].text)
        matrix.set(vector.subarray(0, dims), i * dims)
      }
      await mkdir(cacheDir(), { recursive: true })
      await writeFile(matrixPath(`${docs.length}-${descriptions.sidecarAt ?? 0}`), Buffer.from(matrix.buffer))
      matrixCache = { key: docs.length, dims, matrix, ids: docs.map((doc) => doc.id), buildMs: Date.now() - started }
      return matrixCache
    } finally {
      building = false
    }
  }

  // ---- hybrid recall ---------------------------------------------------------------
  // BM25 scores are unbounded and cosines live in [-1, 1], so the two are fused by rank
  // (reciprocal rank fusion) rather than by a calibrated sum that would rot per catalogue.
  const fuseCandidates = async (rows, document, need) => {
    if (!Array.isArray(rows) || rows.length < 2) return undefined
    const text = String(need ?? '').trim()
    if (!text) return undefined
    const docs = document?.plugins ?? []
    if (!docs.length) return undefined
    const dims = 512
    if (!matrixCache || matrixCache.key !== docs.length) {
      const cached = await loadMatrix(docs.length, dims)
      if (cached) matrixCache = { key: docs.length, dims, matrix: cached, ids: docs.map((plugin) => plugin.name), buildMs: 0, fromDisk: true }
    }
    if (!matrixCache) {
      // The first call after a catalogue change pays ~1 min of CPU. Never make the caller wait:
      // build it in the background and answer lexically meanwhile.
      void buildMatrix(document).catch(() => {})
      return undefined
    }
    const encoder = await encoderOf()
    if (!encoder) return undefined
    const vector = await encoder.embedOne(text)
    const positionOf = new Map(matrixCache.ids.map((id, at) => [id, at]))
    const semantic = rows
      .map((row) => {
        const at = positionOf.get(String(row?.plugin?.name))
        if (at === undefined) return undefined
        return [String(row.plugin.name), cosine(vector, matrixCache.matrix.subarray(at * dims, at * dims + dims))]
      })
      .filter(Boolean)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id)
    const lexical = rows.map((row) => String(row?.plugin?.name))
    const rankOf = new Map(rrfFuse([lexical, semantic]).map((row, at) => [row.id, at]))
    return [...rows].sort((a, b) => (rankOf.get(String(a?.plugin?.name)) ?? 1e9) - (rankOf.get(String(b?.plugin?.name)) ?? 1e9))
  }

  const select = async (args) => {
    const need = args.need ?? args.query ?? args.task
    // Engine selection: bm25 ships; embedding reports what it still needs.
    const engine = String(args.engine ?? 'bm25')
    if (engine === 'embedding') {
      const status = await embeddingStatus()
      if (!status.available) {
        return { engine: 'embedding', available: false, ...status, hint: 'install the encoder, then call again; bm25 is the working default' }
      }
      const encoder = await encoderOf()
      if (!encoder) return { engine: 'embedding', available: false, reason: 'session create failed' }
      const { url } = requireMarket()
      const document = await readIndex(url)
      const docs = document?.plugins ?? []
      const dims = 512
      if (!matrixCache || matrixCache.key !== docs.length) {
        const cached = await loadMatrix(docs.length, dims)
        if (cached) {
          matrixCache = { key: docs.length, dims, matrix: cached, ids: docs.map((p) => p.name), buildMs: 0, fromDisk: true }
        }
      }
      if (!matrixCache) {
        // First use is a one-off minute of CPU; do it in the background and say so.
        void buildMatrix(document).catch(() => {})
        return { engine: 'embedding', building: true, docs: docs.length, hint: 'building the embedding matrix now (~1-2 min); bm25 answers meanwhile' }
      }
      const started = Date.now()
      const query = await encoder.embedOne(String(need ?? queries?.[0] ?? ''))
      const scored = matrixCache.matrix
      const scoredIds = matrixCache.ids
      const top = []
      for (let i = 0; i < scoredIds.length; i += 1) {
        const vector = scored.subarray(i * dims, i * dims + dims)
        top.push([scoredIds[i], cosine(query, vector)])
      }
      top.sort((a, b) => b[1] - a[1])
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 40)
      const byName = new Map(docs.map((plugin) => [plugin.name, plugin]))
      return {
        engine: 'embedding',
        model: 'bge-small-zh-v1.5 (int8)',
        dims,
        docs: scoredIds.length,
        buildMs: matrixCache.buildMs,
        ms: Date.now() - started,
        hits: top.slice(0, limit).map(([id, score]) => ({
          name: id,
          title: plainText(byName.get(id)?.title),
          description: plainText(byName.get(id)?.description),
          score: Math.round(score * 10000) / 10000,
        })),
      }
    }
    const queries = Array.isArray(args.queries) ? args.queries.map((q) => String(q ?? '').trim()).filter(Boolean).slice(0, 6) : undefined
    if (!String(need ?? '').trim() && !queries?.length) throw new Error('need or queries is required for select')
    const { url } = requireMarket()
    const document = await readIndex(url)
    const { index, buildMs } = await bm25Of(document)
    const started = Date.now()
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 40)
    // Several clean queries → keep each document's best score and the terms behind it.
    const scored = new Map()
    for (const query of queries?.length ? queries : [need]) {
      const run = bm25Search(index, query, { limit: Math.max(limit, 20) })
      for (const hit of run.hits) {
        const seen = scored.get(hit.id)
        if (!seen || hit.score > seen.score) scored.set(hit.id, { ...hit, query })
      }
    }
    const hits = [...scored.values()].sort((a, b) => b.score - a.score).slice(0, limit)
    const terms = queries?.length ? queries.length : 1
    const byName = new Map((document?.plugins ?? []).map((plugin) => [plugin.name, plugin]))
    return {
      engine: 'bm25',
      index: url,
      queryTerms: terms,
      docs: index.size,
      terms: [...new Set(bm25Search(index, need, { limit: 1 }).hits.map(() => 0))].length,
      buildMs,
      ms: Date.now() - started,
      hits: hits.map((hit) => {
        const plugin = byName.get(hit.id)
        return {
          name: hit.id,
          title: plainText(plugin?.title),
          description: plainText(plugin?.description),
          score: hit.score,
          matchedQuery: hit.query,
          why: hit.terms,
        }
      }),
      hint: 'pick from these (or say none); action=ensure installs a pick, action=invoke runs a bound tool',
    }
  }

  const recipes = async (args) => {
    const remote = domainsLive(pickIndexUrl())
    const bundled = domainsOf()
    const document = remote ?? bundled
    const source = remote ? 'site' : 'bundled'
    const asked = args.domain ? String(args.domain).toLowerCase() : undefined
    const wanted = asked ? (DOMAIN_ALIASES[asked] ?? asked) : undefined
    const rows = (document.domains ?? [])
      .filter((domain) => !wanted
        || String(domain.id).includes(wanted)
        || String(domain.zh).includes(String(args.domain)))
      .map((domain) => ({
        domain: domain.id,
        need: domain.zh,
        total: domain.total,
        // Compact on purpose: the model needs a name to load, not the engine range it was
        // already filtered by. Repeating a 16-term OR range per row tripled the answer size.
        candidates: (domain.candidates ?? []).map((row) => ({
          name: row.name,
          version: row.version,
          source: row.source,
          tier: row.tier,
          curated: row.curated,
        })),
      }))
    return {
      source,
      builtFor: document.runtime,
      generatedAt: document.generatedAt,
      method: document.method,
      resolved: asked && asked !== wanted ? { asked, domain: wanted } : undefined,
      domains: rows,
      hint: rows.length
        ? 'load { name } the first candidate whose description fits, or ensure with a one-sentence need.'
        : `no domain matched${asked ? ` '${asked}'` : ''}; ids are catalogue categories (data-office, media-voice, …) — call recipes without a domain to list all`
    }
  }

  const outdated = async (args) => {
    const api = requireManager()
    const bundles = (await api.listBundles().catch(() => [])) ?? []
    const profile = bundles.filter((bundle) => bundle.availability === 'profile' && bundle.version)
    // Ask every registry lookup at once: serially this cost ~7.8 s for seven bundles.
    const targets = profile.filter((bundle) => !args.name || bundle.name === args.name)
    const lists = await Promise.all(targets.map((bundle) => api.listVersions(bundle.name, { registry: FAST_REGISTRY }).catch((error) => ({
      status: 'refused',
      problem: 'unknown',
      reason: String(error?.message ?? error),
    }))))
    const rows = []
    for (const [index, bundle] of targets.entries()) {
      if (bundle.updatable === false) {
        rows.push({ name: bundle.name, installed: bundle.version, status: 'not-updatable' })
        continue
      }
      const list = lists[index]
      const best = bestVersionOf(list, bundle.version)
      if (best.refused) {
        rows.push({ name: bundle.name, installed: bundle.version, status: 'unreadable', reason: best.refused.reason ?? best.refused.problem })
        continue
      }
      rows.push({
        name: bundle.name,
        installed: bundle.version,
        latest: best.version,
        status: best.version ? 'outdated' : 'current',
        skippedIncompatible: best.skipped || undefined,
      })
    }
    return {
      registry: FAST_REGISTRY,
      checked: rows.length,
      outdated: rows.filter((row) => row.status === 'outdated'),
      rows,
      hint: rows.some((row) => row.status === 'outdated')
        ? 'Run update with a name (or all:true) to install the listed versions.'
        : undefined,
    }
  }

  // The update itself: the manager removes the old version first (HMR), installs the target,
  // and restores the old one if that install fails.
  // Health check for the proxy path: asserts the batch contract invoke() depends on, and
  // reports the raw shape so a runtime change is visible instead of "the tool does nothing".
  const diagnoseInvoke = async (args) => {
    const name = String(args.tool ?? 'working_directory')
    const agent = ctx.get('agents')?.list?.()[0]
    const callId = `diag-${Date.now()}`
    const probe = async (withAgent) => {
      const started = Date.now()
      try {
        const batch = await ctx.tools.execute({
          calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args.arguments ?? {}) }],
          signal: new AbortController().signal,
          ...(withAgent && agent ? { agent } : {}),
          maxParallelToolCalls: 1,
        })
        const settled = batch?.results?.[0]?.result
        return {
          scope: withAgent ? 'agent' : 'host',
          batchKeys: Object.keys(batch ?? {}),
          resultKeys: Object.keys(batch?.results?.[0] ?? {}),
          isError: settled?.isError ?? null,
          code: settled?.error?.info?.code,
          message: settled?.error?.message,
          valueType: settled?.value === undefined ? 'undefined' : typeof settled.value,
          ms: Date.now() - started,
        }
      } catch (error) {
        return { scope: withAgent ? 'agent' : 'host', thrown: String(error?.message ?? error), ms: Date.now() - started }
      }
    }
    const host = await probe(false)
    const scoped = agent ? await probe(true) : undefined
    const masked = host.isError === false || (host.code && host.code !== 'UNKNOWN_TOOL')
    return {
      tool: name,
      contract: 'execute({ calls:[{type:"tool-call",id,name,arguments}], signal, agent? })',
      host,
      scoped,
      verdict: masked
        ? 'ok'
        : host.code === 'UNKNOWN_TOOL'
          ? 'tool-not-visible-in-host-scope'
          : 'unexpected',
      maskedHint: host.code === 'UNKNOWN_TOOL'
        ? 'this name is not registered (or belongs to a bundle that is not loaded)'
        : undefined,
    }
  }

  const unadopt = async (args) => {
    const wanted = Array.isArray(args.tools) && args.tools.length ? args.tools.map(String) : undefined
    const removed = []
    for (const name of [...hiddenTools]) {
      if (wanted && !wanted.includes(name)) continue
      hiddenTools.delete(name)
      removed.push(name)
    }
    if (removed.length) {
      await saveHidden()
      await refreshRestrictions()
    }
    return { removed, remaining: [...hiddenTools], hint: removed.length ? 'Those tools are visible again from the next turn.' : 'nothing was masked' }
  }

  // Never mask the entry point itself: with lazy_plugin hidden there would be no way to
  // invoke anything back.
  const ADOPT_SKIP = new Set(['@local/dsh-lazy-plugins'])

  // Tools this rule must never hide: the entry point, and the ops_* tooling the agent needs
  // to do anything at all when the plugin that provides it is "on demand".
  const KEEP_VISIBLE = new Set([
    'lazy_plugin',
    'ops_bash', 'ops_grep', 'ops_glob', 'ops_read_files', 'ops_inspect_local_file',
    'ops_result', 'ops_discover_tools',
  ])

  const adoptAll = async (args, exec) => {
    const globalNames = [...new Set((ctx.tools?.schemas?.() ?? []).map((schema) => schema.name))]
    const agentNames = new Set(globalNames)
    for (const agent of ctx.get('agents')?.list?.() ?? []) {
      for (const schema of ctx.tools?.schemas?.(agent) ?? []) agentNames.add(schema.name)
    }
    // Plugin-scope tools: the sandbox/panel family dsh-ops adds beyond its shell tooling.
    const scopePlugins = [...agentNames].filter((name) => /^ops_/.test(name) && !KEEP_VISIBLE.has(name))
    const targets = [...new Set([...globalNames, ...scopePlugins])].filter((name) => !KEEP_VISIBLE.has(name))
    if (args.dry === true) {
      return {
        dryRun: true,
        agentTools: agentNames.size,
        globalTools: globalNames.length,
        targets: targets.length,
        sample: targets,
        kept: [...KEEP_VISIBLE].filter((name) => agentNames.has(name)),
        hint: 'global plugin tools + the ops_ family; nothing was changed',
      }
    }
    for (const name of targets) hiddenTools.add(name)
    await rememberTools('*', targets)
    await saveHidden()
    await refreshRestrictions({ only: exec?.agent?.id })
    return {
      masked: targets.length,
      maskedTotal: hiddenTools.size,
      keptVisible: [...KEEP_VISIBLE].filter((name) => agentNames.has(name)),
      sample: targets,
      hint: 'plugin tools now run through action=invoke; undo with action=unadopt (no tools argument clears every mask).',
    }
  }

  const adopt = async (args, exec) => {
    if (args.all === true) return adoptAll({ ...args, all: false }, exec)
    const api = requireManager()
    const real = realNameOf(args.name)
    const where = await residency(real)
    if (where.kind === 'base') return baseRefusal(args.name, 'adopt')
    const before = visibleToolNames()
    const off = await profileWrite(() => api.setBundleEnabled(real, false))
    if (off.error) return { name: args.name, stage: 'disable', error: off.error.code, diagnostic: off.error.diagnostic }
    // The tool set updates asynchronously; poll briefly instead of guessing a delay.
    let during = visibleToolNames()
    // Poll until the tool set actually shrinks, with backoff: a fixed 12x120 ms window was
    // too short for a bundle whose rows register asynchronously (measured: "no-tools-observed"
    // on a plugin that had been adopted successfully minutes earlier).
    for (let attempt = 0; attempt < 20 && during.size >= before.size; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(150 * attempt, 400)))
      during = visibleToolNames()
    }
    const owned = [...before].filter((name) => !during.has(name))
    const on = await profileWrite(() => api.setBundleEnabled(real, true))
    if (on.error) {
      return { name: args.name, stage: 'enable', error: on.error.code, diagnostic: on.error.diagnostic, owned }
    }
    if (!owned.length) {
      return { name: args.name, adopted: [], reason: 'no-tools-observed', hint: 'This bundle exposes no tools (a UI-only or event-only plugin), so there is nothing to hide; leaving it alone.' }
    }
    if (args.dry === true) return { name: args.name, dryRun: true, owned }
    await rememberTools(real, owned)
    for (const name of owned) hiddenTools.add(name)
    await saveHidden()
    await refreshRestrictions({ only: exec?.agent?.id })
    return {
      name: args.name,
      adopted: owned,
      hiddenTools: owned.length,
      enabled: true,
      callWith: 'invoke',
      promptImpact: `the visible tool set will shrink by ${owned.length} on the next turn (tool masks apply per agent); call them through action=invoke`,
    }
  }

  const update = async (args) => {
    const api = requireManager()
    if (typeof api.updateBundle !== 'function') throw new Error('this dsh runtime does not expose updateBundle(); use load with an explicit version instead')
    const plan = await outdated({ name: args.name })
    const targets = args.all === true ? plan.outdated : plan.outdated.filter((row) => row.name === args.name)
    if (!targets.length) {
      return args.name
        ? { name: args.name, updated: false, reason: 'up-to-date-or-not-updatable', rows: plan.rows }
        : { updated: 0, reason: 'nothing-outdated', rows: plan.rows }
    }
    const results = []
    for (const target of targets) {
      const started = Date.now()
      const outcome = await profileWrite(() => api.updateBundle(target.name, target.latest, { registry: FAST_REGISTRY }))
        .catch((error) => ({ error: { code: String(error?.message ?? error) } }))
      results.push({
        name: target.name,
        from: target.installed,
        to: target.latest,
        step: outcome?.step,
        application: outcome?.result?.application ?? 'failed',
        error: outcome?.error?.code ?? outcome?.result?.error?.code,
        restored: outcome?.restore ? outcome.restore.application : undefined,
        diagnostic: outcome?.result?.error?.diagnostic ?? outcome?.error?.diagnostic,
        ms: Date.now() - started,
      })
      if (outcome?.result?.application === 'applied') {
        await recordUsage(target.name, 'load')
        await addPool(target.name)
      } else {
        await recordFailure(target.name, target.latest, String(outcome?.error?.code ?? 'update-failed'))
      }
    }
    return {
      updated: results.filter((row) => row.application === 'applied').length,
      results,
      restartRequired: results.some((row) => row.application === 'restart-required') || undefined,
      ms: results.reduce((sum, row) => sum + (row.ms ?? 0), 0),
    }
  }

  // Read-only health check: nothing here writes to the profile.
  const verify = async () => {
    const dir = profileDir()
    if (!dir) return { ok: false, error: 'profile directory not found (this plugin is expected to be a profile dependency)' }
    const runtime = runtimeVersionOf()
    let manifest = { dependencies: {}, dsh: { profile: { bundles: [] } } }
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch (error) {
      return { ok: false, error: 'profile package.json is unreadable: ' + String(error?.message ?? error) }
    }
    const deps = manifest?.dependencies ?? {}
    const bundles = manifest?.dsh?.profile?.bundles ?? []
    let lock = ''
    try {
      lock = readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')
    } catch {
      lock = ''
    }
    const factsDoc = (await installFactsOf(pickIndexUrl())) ?? {}
    const plugins = []
    for (const [name, declared] of Object.entries(deps)) {
      let pkg
      try {
        pkg = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8'))
      } catch {
        pkg = undefined
      }
      const engines = pkg?.engines?.dsh
      const compatible = engines && runtime.version ? satisfiesEngines(runtime.version, engines) : undefined
      const site = factsDoc.mode === 'full' ? factsDoc.map?.[name] : undefined
      plugins.push({
        name,
        declared,
        installed: pkg?.version,
        enginesDsh: engines,
        compatible,
        inNodeModules: Boolean(pkg),
        inBundles: bundles.includes(name),
        inLockfile: lock ? lock.includes(name) : undefined,
        latest: site?.version,
        latestEngines: site?.engines,
        indexBehind: Boolean(pkg?.version && site?.version && pkg.version !== site.version),
        fix: compatible === false
          ? `the running dsh ${runtime.version} rejects this version; upgrade ${name} to a release whose engines.dsh admits ${runtime.version} (dsh-ops@0.5.0 is the known example)`
          : undefined,
      })
    }
    // Orphans (installed but not declared) and dangling links are what a failed install
    // leaves behind; both were present on 2026-11-08 and both confuse the loader.
    let modulesYaml = ''
    try {
      modulesYaml = readFileSync(join(dir, 'node_modules', '.modules.yaml'), 'utf8')
    } catch {
      modulesYaml = ''
    }
    const orphans = []
    const dangling = []
    const scanned = []
    try {
      for (const entry of readdirSync(join(dir, 'node_modules'), { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        if (entry.name.startsWith('.')) continue
        if (entry.name.startsWith('@')) {
          try {
            for (const scoped of readdirSync(join(dir, 'node_modules', entry.name), { withFileTypes: true })) {
              if (scoped.name.startsWith('.')) continue
              scanned.push(`${entry.name}/${scoped.name}`)
            }
          } catch {}
          continue
        }
        scanned.push(entry.name)
      }
      for (const name of scanned) {
        const full = join(dir, 'node_modules', name)
        const declared = Object.prototype.hasOwnProperty.call(deps, name)
        // A hoisted transitive dependency is legitimate: only a package pnpm does not
        // know about at all is residue.
        if (!declared && !(modulesYaml && modulesYaml.includes(name))) orphans.push(name)
        try {
          const stat = lstatSync(full)
          if (stat.isSymbolicLink()) {
            const target = readlinkSync(full)
            const resolved = target.startsWith('.') ? join(dir, 'node_modules', target) : target
            if (!existsSync(resolved)) dangling.push({ name, target: resolved })
          }
        } catch {
          dangling.push({ name, target: 'unreadable' })
        }
      }
    } catch (error) {
      orphans.push('scan-failed: ' + String(error?.message ?? error))
    }
    // Settings projection: what the harness would render for this plugin (autoGenerate).
    let settingsPage
    try {
      const described = ctx.get('settings')?.describe?.() ?? []
      settingsPage = described
        .filter((row) => String(row?.ns ?? '').includes('lazy-plugins'))
        .map((row) => ({ ns: row.ns, autoGenerate: row.autoGenerate, applies: row.applies, hasSchema: Boolean(row.schema) }))
    } catch (error) {
      settingsPage = [{ error: String(error?.message ?? error) }]
    }
    const incompatible = plugins.filter((row) => row.compatible === false)
    // Turn "upgrade it" into an actual version to install.
    for (const row of incompatible) {
      if (!runtime.version) continue
      const fix = await compatibleVersionOf(row.name, runtime.version)
      if (fix) {
        row.fixVersion = fix.version
        row.fixEngines = fix.enginesDsh
        row.fix = `install ${row.name}@${fix.version} (engines.dsh ${fix.enginesDsh ?? 'unspecified'} admits ${runtime.version}) with load { name, version }`
      }
    }
    runtimeHealth = {
      checkedAt: Date.now(),
      runtime: runtime.version,
      incompatible: incompatible.map((row) => ({ name: row.name, installed: row.installed, enginesDsh: row.enginesDsh })),
      verdict: incompatible.length ? 'action-needed' : 'ok',
    }
    const missing = plugins.filter((row) => !row.inNodeModules)
    return {
      ok: true,
      runtime,
      profile: dir,
      plugins,
      incompatible,
      missing,
      orphans: orphans.filter((name) => !name.startsWith('scan-failed:')),
      dangling,
      catalogs: {
        site: (await installFactsOf(pickIndexUrl()))
          ? ((doc) => ({
              mode: doc.mode,
              entries: doc.mode === 'full' ? Object.keys(doc.map ?? {}).length : doc.count,
              notInstallable: (doc.notInstallable ?? []).length || undefined,
              unverified: (doc.unverified ?? []).length || undefined,
              at: new Date(doc.at ?? 0).toISOString(),
            }))(await installFactsOf(pickIndexUrl()))
          : undefined,
        community: (await catalogOf())
          ? ((row) => ({ entries: row.count, at: new Date(row.at ?? 0).toISOString(), source: row.source }))(await catalogOf())
          : undefined,
      },
      settingsPage,
      configSchema: Boolean(Config),
      configError,
      verdict: incompatible.length || missing.length || dangling.length ? 'action-needed' : 'ok',
      hint: incompatible.length
        ? 'A dependency is denied by the running runtime. This is exactly what an app update does; upgrade those packages (see fix) and restart once.'
        : undefined,
    }
  }

  const advise = async (agent) => {
    const api = requireManager()
    const bundles = (await api.listBundles().catch(() => [])) ?? []
    const profile = bundles.filter((bundle) => bundle.availability === 'profile')
    let schemas = []
    try {
      schemas = ctx.tools?.schemas?.(agent) ?? []
    } catch {
      schemas = []
    }
    // ~4 bytes per token is the usual rule of thumb; reported as an estimate only.
    const schemaBytes = schemas.reduce((sum, schema) => sum + JSON.stringify(schema).length, 0)
    await loadUsage()
    const usageRows = profile.map((bundle) => {
      const row = usage.packages[bundle.name]
      const last = row?.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : undefined
      return {
        name: bundle.name,
        enabled: bundle.enabled,
        loads: row?.loads?.length ?? 0,
        lastUsedAt: last,
        loadedByTool: loaded.has(bundle.name),
      }
    })
    const suggestions = []
    for (const row of usageRows) {
      // Only packages this tool loaded itself can be judged by these counters; the rest
      // were installed deliberately outside it and are reported, not questioned.
      if (!row.loadedByTool) continue
      if (!row.enabled && row.loads > 0) suggestions.push(`${row.name}: used ${row.loads}x but disabled — reload it or release it`)
    }
    for (const bundle of profile) {
      const where = await residency(bundle.name, bundles)
      if (where.kind === 'auto' && !bundle.enabled) suggestions.push(`${bundle.name}: frequent use (score ${where.score}) but disabled — enable as resident`)
    }
    if (runtimeHealth.incompatible.length) {
      const names = runtimeHealth.incompatible.map((row) => `${row.name}@${row.installed}`).join(', ')
      suggestions.push(`runtime ${runtimeHealth.runtime} denies ${names} (engines.dsh mismatch) — those plugins do not load; upgrade each to a release whose engines.dsh admits this runtime, then restart once`)
    }
    if ((await readPool()).length) {
      const names = await readPool()
      const staleNames = names.filter((name) => {
        const row = usage.packages[name]
        return !row || (row.lastUsedAt && Date.now() - row.lastUsedAt > 30 * 86400000)
      })
      if (staleNames.length) {
        suggestions.push(`in the auto-install pool and unused for 30+ days: ${staleNames.join(', ')} — kept by default; release only if you need the space`)
      }
    }
    if (schemaBytes > 60000) {
      suggestions.push(`tool schemas total ${schemaBytes} B (~${Math.round(schemaBytes / 4)} tokens of prompt); consider deferLoading or unloading unused plugins`)
    }
    const index = await indexState()
    if (!index.cached) suggestions.push('no index copy on disk yet — the first search pays the download')
    return {
      profile: {
        bundles: bundles.length,
        profileBundles: profile.length,
        enabledProfileBundles: profile.filter((bundle) => bundle.enabled).length,
      },
      tools: {
        count: schemas.length,
        schemaBytes,
        estimatedPromptTokens: Math.round(schemaBytes / 4),
        // Any change here invalidates the model-side prompt prefix (tools are a separate
        // API field sorted by name), so it doubles as a cache-stability fingerprint.
        signature: createHash('sha1').update(schemas.map((schema) => schema.name).sort().join(',')).digest('hex').slice(0, 12),
        hiddenByProxy: [...hiddenTools],
        maskDiagnostics: maskDiagnostics.slice(-6),
        // The host-wide view, for comparison: the agent view is what the model sees.
        countGlobal: (ctx.tools?.schemas?.() ?? []).length,
      },
      cache: { ...stats, index },
      usage: usageRows,
      runtimeHealth,
      perf: await (async () => {
        await loadTimings()
        return perfSummary()
      })(),
      pool: await (async () => {
        const names = await readPool()
        const stale = names.filter((name) => {
          const row = usage.packages[name]
          const last = row?.lastUsedAt ? Date.now() - row.lastUsedAt : Infinity
          return !row || last > 30 * 86400000
        })
        return { autoInstalled: names.length, recentFailures: Object.keys(await readFailed()).length, stale: stale.length ? stale : undefined }
      })(),
      skillError,
      repeatedFailures: repeatedFailureRows(),
      promptSection: promptSectionRegistered,
      skill: await (async () => {
        try {
          const listed = await ctx.get('skills')?.list?.({})
          return (listed ?? []).filter((entry) => entry.name === 'lazy-plugins').map((entry) => `${entry.name}:${entry.source}`)
        } catch {
          return []
        }
      })(),
      suggestions,
    }
  }

  const list = async () => {
    const api = requireManager()
    const poolSet = new Set(await readPool())
    const bundles = await api.listBundles()
    const profile = (bundles ?? []).filter((bundle) => bundle.availability === 'profile')
    const rows = []
    for (const bundle of bundles ?? []) {
      const where = await residency(bundle.name, bundles)
      rows.push({
        name: bundle.name,
        scope: bundle.availability,
        version: bundle.version,
        enabled: bundle.enabled,
        removable: bundle.removable,
        resident: where.resident ? where.kind : undefined,
        score: where.score,
        rows: (bundle.rows ?? []).map((row) => row.rowId),
      })
    }
    return {
      pluginVersion: VERSION,
      lazyLoaded: [...loaded],
      installedAs: Object.fromEntries(installedUnder),
      cache: (() => {
        const lookups = stats.indexMemoryHits + stats.indexDiskHits + stats.indexNetwork
        return {
          ...stats,
          // A 304 still hits the network but transfers no document, so it counts as a hit.
          indexHitRate: lookups ? Math.round(((stats.indexMemoryHits + stats.indexDiskHits + stats.indexNotModified) / lookups) * 1000) / 10 : undefined,
        }
      })(),
      residencyRule: `base bundles are protected; a package becomes resident at score >= ${Number(settings.residentScore) || DEFAULTS.residentScore} (loads + 0.3*manual enables, ${Number(settings.halfLifeDays) || DEFAULTS.halfLifeDays}-day half-life)`,
      warmed,
      pending: (await readPending()).map((item) => item.name),
      index: await indexState(),
      installed: rows.filter((row) => row.scope === 'profile' && !poolSet.has(row.name)),
      autoPool: rows.filter((row) => row.scope === 'profile' && poolSet.has(row.name)),
      // Only the active built-ins are protected; a disabled one is the composition's call.
      base: rows.filter((row) => row.scope !== 'profile' && row.enabled).map((row) => row.name),
    }
  }

  // Warming only ever touches profile bundles. Built-ins belong to the composition: a
  // disabled `headless` or `sdk-app` is a deliberate choice, and switching one on is not
  // this tool's business (an earlier revision tried and collected operation-error rows).
  // Enable everything queued by activate:'boot'. Runs once per plugin activation, so the
  // visible tool set changes at a session boundary instead of mid-conversation.
  // Walk up from this plugin's real location to the profile that owns the composition.
  // A `link:` install lives outside the profile, so its own path says nothing; the
  // profile is whichever ~/.dsh/profiles/* manifest depends on this plugin.
  // One profile mutation at a time. pnpm rewrites the profile and the loader reconciles;
  // two operations overlapping inside that window is what produced the 01:13 double boot.
  let writeChain = Promise.resolve()
  const profileWrite = (task) => {
    const run = writeChain.then(task, task)
    writeChain = run.then(() => {}, () => {})
    return run
  }

  // The running harness version. Inside the Electron host the asar is readable through
  // Node's fs, which is the only authoritative source without asking the user.
  const runtimeVersionOf = () => {
    for (const key of ['app', 'product', 'runtime', 'dsh']) {
      try {
        const value = ctx.get(key)?.version
        if (typeof value === 'string' && /^\d+\./.test(value)) return { version: value, source: `service:${key}` }
      } catch {
        // not a service here
      }
    }
    try {
      const resources = process.resourcesPath
      if (resources) {
        const manifest = JSON.parse(readFileSync(join(resources, 'app.asar', 'dsh', 'package.json'), 'utf8'))
        if (typeof manifest?.version === 'string') return { version: manifest.version, source: 'asar' }
      }
    } catch {
      // plain Node cannot read inside an asar
    }
    if (process.env.DSH_VERSION) return { version: process.env.DSH_VERSION, source: 'env' }
    return { version: undefined, source: 'unknown' }
  }

  const profileDir = () => {
    const root = join(homedir(), '.dsh', 'profiles')
    try {
      for (const entry of readdirSync(root)) {
        const manifest = join(root, entry, 'package.json')
        if (!existsSync(manifest)) continue
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
        const deps = parsed?.dependencies ?? {}
        if (Object.keys(deps).some((name) => name.startsWith('@local/dsh-lazy-plugins'))) return join(root, entry)
      }
    } catch {
      // no reachable profile
    }
    return null
  }

  const warmResident = async () => {
    const api = manager()
    if (!api) return
    const actions = []
    try {
      const bundles = (await api.listBundles()) ?? []
      const explicit = new Set((settings.resident ?? []).map(String))
      for (const bundle of bundles) {
        if (bundle.availability !== 'profile') continue
        const where = await residency(bundle.name)
        if (!where.resident) continue
        if (bundle.enabled) {
          actions.push({ name: bundle.name, state: 'already-enabled', kind: where.kind })
          continue
        }
        const result = await api.setBundleEnabled(bundle.name, true)
        actions.push({ name: bundle.name, state: result.error ? `error:${result.error.code}` : 'enabled', kind: where.kind })
      }
      for (const name of explicit) {
        if (!bundles.some((bundle) => bundle.name === name)) actions.push({ name, state: 'not-installed', kind: 'explicit' })
      }
    } catch (error) {
      actions.push({ state: 'error', error: String(error?.message ?? error) })
    }
    warmed = [...(warmed ?? []), ...actions]
  }

  // One explicit index refresh, shared by the startup trigger, the daily fallback, the
  // panel route and the `refresh` action. A conditional request keeps it cheap: the
  // primary source answers 304 with no body, so "current" costs ~0.6 s, not 1 MB.
  // One row per profile bundle, with the facts the panel does not show: usage, whether the
  // tools are proxied away, and whether a newer version would be accepted.
  const panelRows = async () => {
    const api = requireManager()
    const bundles = (await api.listBundles().catch(() => [])) ?? []
    await loadUsage()
    await loadToolMap()
    // The mask is restored by the boot trigger; a panel fetched earlier would otherwise report
    // zero hidden tools. loadHidden() is idempotent.
    await loadHidden()
    const rows = []
    for (const bundle of bundles) {
      if (bundle.availability !== 'profile') continue
      const where = await residency(bundle.name, bundles)
      const usageRow = usage.packages[bundle.name]
      const owned = toolMap.get(bundle.name) ?? []
      const hidden = owned.filter((name) => hiddenTools.has(name))
      rows.push({
        name: bundle.name,
        version: bundle.version,
        enabled: bundle.enabled,
        removable: bundle.removable,
        resident: where.resident ? where.kind : undefined,
        loads: usageRow?.loads?.length ?? 0,
        lastUsedAt: usageRow?.lastUsedAt ? new Date(usageRow.lastUsedAt).toISOString() : undefined,
        ownedTools: owned.length || undefined,
        hiddenTools: hidden.length || undefined,
        updatable: bundle.updatable !== false,
      })
    }
    const globalSchemas = ctx.tools?.schemas?.() ?? []
    const agents = ctx.get('agents')?.list?.() ?? []
    const agentSchemas = agents[0] ? (ctx.tools?.schemas?.(agents[0]) ?? []) : []
    return {
      rows,
      tools: { global: globalSchemas.length, count: agentSchemas.length || globalSchemas.length, hidden: [...hiddenTools].length },
      runtime: runtimeVersionOf().version,
      autoPool: await readPool(),
      generatedAt: new Date().toISOString(),
    }
  }

  // The actions the panel itself does not expose. Everything goes through the same write
  // lock the agent-facing actions use, so a page click cannot interleave with a tool call.
  const panelAct = async (body) => {
    const action = String(body?.action ?? '')
    const name = String(body?.name ?? '')
    if (!name) throw new Error('name is required')
    const api = requireManager()
    if (action === 'enable') return api.setBundleEnabled(name, true)
    if (action === 'disable') return api.setBundleEnabled(name, false)
    if (action === 'reload') return reload({ name })
    if (action === 'remove') return uninstall({ name })
    if (action === 'update') return update({ name })
    if (action === 'adopt') return adopt({ name })
    if (action === 'unadopt') return unadopt({ name })
    throw new Error('unknown action: ' + action)
  }

  // One sweep per process, in the background. Anything it decides badly is recoverable:
  // `updateBundle` keeps a rollback and `verify` reports the engines verdict afterwards.
  let autoUpdateDone = false
  const autoUpdatePool = async () => {
    if (autoUpdateDone) return { skipped: 'already-ran' }
    autoUpdateDone = true
    if (String(settings.autoUpdate ?? DEFAULTS.autoUpdate) === 'off') return { skipped: 'off' }
    const api = manager()
    if (!api || typeof api.updateBundle !== 'function' || typeof api.listVersions !== 'function') return { skipped: 'no-update-api' }
    const pool = (await readPool()).filter((name) => !name.startsWith('@local/dsh-lazy-plugins'))
    if (!pool.length) return { skipped: 'empty-pool' }
    const bundles = (await api.listBundles().catch(() => [])) ?? []
    const installed = new Map(bundles.map((bundle) => [bundle.name, bundle]))
    const cap = Math.max(1, Number(settings.autoUpdateMax) || DEFAULTS.autoUpdateMax)
    const applied = []
    const failed = []
    for (const name of pool) {
      if (applied.length >= cap) break
      const bundle = installed.get(name)
      if (!bundle || bundle.updatable === false) continue
      const list = await api.listVersions(name, { registry: FAST_REGISTRY }).catch(() => undefined)
      const best = bestVersionOf(list, bundle.version)
      if (!best.version || best.version === bundle.version) continue
      const outcome = await profileWrite(() => api.updateBundle(name, best.version, { registry: FAST_REGISTRY }))
        .catch((error) => ({ error: { code: String(error?.message ?? error) } }))
      if (outcome?.result?.application === 'applied') {
        applied.push({ name, from: bundle.version, to: best.version })
        await recordUsage(name, 'load')
      } else {
        const reason = String(outcome?.error?.code ?? outcome?.result?.error?.code ?? 'update-failed')
        failed.push({ name, from: bundle.version, to: best.version, reason })
        await recordFailure(name, best.version, reason)
      }
    }
    return { applied, failed, checked: pool.length }
  }

  // Repeated-failure ledger: tool name + a normalized error head, per agent. Two occurrences of
  // the same signature is enough evidence that the current approach is stuck — the signal the
  // prompt section never had (a session hitting the same WPF type error three times read that as
  // "an ordinary code edit" and never looked at the market).
  const failureLedger = new Map()
  const FAILURE_WINDOW_MS = 30 * 60 * 1000
  const signatureOf = (result) => {
    try {
      const raw = result?.isError ? (result.error ?? result.content ?? result) : undefined
      if (!raw) return undefined
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
      return text.replace(/\s+/g, ' ').replace(/[0-9a-f]{8,}/gi, '#').slice(0, 120)
    } catch {
      return undefined
    }
  }

  const noteFailure = (exec, result) => {
    const signature = signatureOf(result)
    if (!signature) return
    const agentKey = String(exec?.agent?.id ?? 'session')
    const tool = String(exec?.call?.name ?? exec?.name ?? 'tool')
    const now = Date.now()
    const ledger = failureLedger.get(agentKey) ?? new Map()
    const key = tool + ' ' + signature
    const entry = ledger.get(key) ?? { tool, signature, count: 0, firstAt: now, lastAt: now }
    entry.count += 1
    entry.lastAt = now
    ledger.set(key, entry)
    if (ledger.size > 20) {
      const oldest = [...ledger.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0]
      if (oldest) ledger.delete(oldest[0])
    }
    failureLedger.set(agentKey, ledger)
  }

  // The newest signature that crossed the threshold inside the window, if any.
  const recentBlockedFailure = () => {
    const now = Date.now()
    let best
    for (const ledger of failureLedger.values()) {
      for (const entry of ledger.values()) {
        if (entry.count < 2) continue
        if (now - entry.lastAt > FAILURE_WINDOW_MS) continue
        if (!best || entry.lastAt > best.lastAt) best = entry
      }
    }
    return best
  }

  // Reported by `advise`: a signature that repeats is a market-lookup candidate.
  const repeatedFailureRows = () => {
    // One signature can appear under several agent keys (a host-scope invoke has no agent);
    // collapse them so the report reads as one repeated failure, not two.
    const bySignature = new Map()
    for (const entry of [...failureLedger.values()].flatMap((ledger) => [...ledger.values()])) {
      if (entry.count < 2 || Date.now() - entry.lastAt > FAILURE_WINDOW_MS) continue
      const seen = bySignature.get(entry.signature)
      if (!seen) bySignature.set(entry.signature, { ...entry })
      else seen.count = Math.max(seen.count, entry.count)
    }
    return [...bySignature.values()]
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, 5)
      .map((entry) => ({ tool: entry.tool, count: entry.count, signature: entry.signature.slice(0, 80) }))
  }

  // BM25 index over the catalogue, built once per process on first use (~1-2 s for 13.8k
  // short documents) and then queried in single-digit milliseconds.
  // Catalogue text fields are locale objects ({en, zh}); BM25 needs the string the reader sees.
  const plainText = (value) => {
    if (typeof value === 'string') return value
    if (!value || typeof value !== 'object') return ''
    return String(value.zh ?? value.en ?? Object.values(value).find((entry) => typeof entry === 'string') ?? '')
  }

  let bm25Cache
  const bm25Of = async (document) => {
    const key = String(document?.generatedAt ?? '') + ':' + (document?.plugins?.length ?? 0) + ':' + String(descriptions.sidecarAt ?? 0)
    if (bm25Cache?.key === key) return bm25Cache
    const started = Date.now()
    // Prefer the sidecar text when the site publishes it (full sentences); fall back to the
    // truncated index field so a missing sidecar never breaks retrieval.
    const descriptionMap = await loadDescriptionMap().catch(() => new Map())
    const docs = (document?.plugins ?? []).map((plugin) => ({
      id: plugin.name,
      text: [plugin.name, plainText(plugin.title), descriptionMap.get(plugin.name) ?? plainText(plugin.description), (plugin.metadata?.labels ?? []).join(' ')].filter(Boolean).join(' '),
    }))
    const index = buildBm25Index(docs)
    bm25Cache = { key, index, buildMs: Date.now() - started }
    return bm25Cache
  }

  const refreshIndex = async () => {
    const { url } = requireMarket()
    const current = indexCache.get(url) ?? (settings.diskCache ? await readDisk(url) : null)
    const started = Date.now()
    const conditional = current?.etag || current?.lastModified
      ? { etag: current.etag, lastModified: current.lastModified, source: current.source }
      : undefined
    stats.indexNetwork += 1
    const result = await fetchChain(url, conditional)
    if (result.notModified) stats.indexNotModified += 1
    if (result.notModified && current?.document) {
      await storeIndex(url, { ...current, at: Date.now(), checkedAt: Date.now() })
      return { index: url, notModified: true, ms: Date.now() - started }
    }
    await storeIndex(url, {
      at: Date.now(),
      checkedAt: Date.now(),
      document: result.document,
      etag: result.etag,
      lastModified: result.lastModified,
      source: result.source,
    })
    return {
      index: url,
      notModified: false,
      source: result.source,
      plugins: (result.document.plugins ?? []).length,
      ms: Date.now() - started,
    }
  }

  const tool = {
    name: 'lazy_plugin',
    // dsh-tool-manager defers tool schemas to save context; this stays visible by
    // default because the agent must be able to discover that on-demand loading exists.
    ...(settings.deferLoading ? { deferLoading: true } : {}),
    // One line, always injected. The detail lives in the `lazy-plugins` skill body, which the
    // harness loads only when the model asks for it — the Claude-style split.
    description:
      'Find, install and call market plugins on demand. Read the lazy-plugins skill before the '
      + 'first use; actions: ensure, load, invoke, release, list, advise.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'suggest', 'ensure', 'resolve', 'recipes', 'load', 'reload', 'unload', 'release', 'uninstall', 'list', 'refresh', 'advise', 'invoke', 'tune', 'wait', 'verify', 'outdated', 'update', 'adopt', 'unadopt', 'diag'],
          description: 'What to do.',
        },
        name: { type: 'string', description: 'Package name.' },
        query: { type: 'string', description: 'search: keyword.' },
        task: { type: 'string', description: 'suggest: task in one sentence.' },
        need: { type: 'string', description: 'ensure/select: needed capability, one sentence.' },
        context: { type: 'string', description: 'ensure: what already failed (404, wrong tool, blocked API) so the model can route around it.' },
        use: { type: 'boolean', description: 'ensure: true = run the new bundle\'s first tool in this same call and return its result.' },
        useArguments: { type: 'object', description: 'ensure+use: arguments for that first call (default {}).' },
        auto: { type: 'boolean', description: 'ensure: false = report only.' },
        judge: { type: 'boolean', description: 'suggest: true = let the session model reorder the list (adds one small call).' },
        keep: { type: 'boolean', description: 'load: keep even with no tools/skills.' },
        force: { type: 'boolean', description: 'load: install even when only the slow registry serves it.' },
        all: { type: 'boolean', description: 'update: update every outdated package.' },
        domain: { type: 'string', description: 'recipes: one domain id to show (omit for all).' },
        tools: { type: 'array', items: { type: 'string' }, description: 'unadopt: tool names to reveal again (omit for all).' },
        background: { type: 'boolean', description: 'load: return a requestId immediately.' },
        requestId: { type: 'string', description: 'load/wait: background job id.' },
        key: { type: 'string', description: 'tune: config key; omit to list.' },
        value: { description: 'tune: value.' },
        version: { type: 'string', description: 'Exact version (default newest).' },
        limit: { type: 'number', description: 'Rows, 1-40, default 10.' },
        offset: { type: 'number', description: 'Paging: use nextOffset.' },
        tool: { type: 'string', description: 'invoke: tool name.' },
        arguments: { type: 'object', description: 'invoke: tool arguments.', additionalProperties: true },
        activate: {
          type: 'string',
          enum: ['now', 'session', 'proxy'],
          description: 'load: proxy (default: hides tools, keeps prompt cache) | now (visible) | session (install only).',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const action = String(args?.action ?? '')
      const run = async () => {
        if (action === 'search') return search(args)
        if (action === 'suggest') return suggest(args)
        if (action === 'ensure') return ensure(args)
        if (action === 'list') return list()
        if (action === 'advise') return advise(exec?.agent)
        if (action === 'tune') return tune(args)
        if (action === 'verify') return verify()
        if (action === 'recipes') return recipes(args)
        if (action === 'select') return select(args)
        if (action === 'corpus') return corpus(args)
        if (action === 'repairExec') return repairExec(args)
        if (action === 'shadow') return shadow(args)
        if (action === 'baseline') return baseline(args)
        if (action === 'outdated') return outdated(args)
        if (action === 'update') return update(args)
        if (action === 'adopt') return adopt(args, exec)
        if (action === 'unadopt') return unadopt(args, exec)
        if (action === 'diag') return diagnoseInvoke(args)
        if (action === 'invoke') return invoke(args, exec)
        if (action === 'refresh') {
          const result = await refreshIndex()
          await warmResident()
          return { ...result, warmed }
        }
        if (action === 'resolve') {
          const { entry, url } = await findEntry(args.name)
          const preferred = entry.defaultVersion ?? entry.versions?.[0]?.version
          const [row] = await enrich([summarize(entry)])
          return {
            index: url,
            entry: row,
            // The index renames duplicates; the published name survives in `title`.
            installAlternatives: aliasNamesOf(entry).map((alias) => `${alias}@${preferred}`),
            versions: (entry.versions ?? []).map((item) => ({
              version: item.version,
              publishedAt: item.publishTimestamp ? new Date(item.publishTimestamp * 1000).toISOString() : undefined,
              spec: item.install?.spec,
              compatible: item.compatibility?.compatible,
            })),
          }
        }
        if (action === 'load') {
          if (!args.name) throw new Error('name is required for load')
          if (args.background === true) {
            const requestId = startBackgroundLoad(args.name, args)
            return {
              name: args.name,
              background: true,
              requestId,
              hint: 'The install continues in the background; call action=wait with this requestId to collect the outcome.',
            }
          }
          return load(args, exec)
        }
        if (action === 'wait') {
          const requestId = args.requestId ? String(args.requestId) : undefined
          if (!requestId) return { pending: [...backgroundJobs.keys()] }
          const job = backgroundJobs.get(requestId)
          if (!job) return { requestId, done: false, error: 'unknown requestId' }
          const settled = await Promise.race([job, Promise.resolve(undefined)])
          if (!settled) return { requestId, done: false, hint: 'Still installing; call wait again.' }
          backgroundJobs.delete(requestId)
          return settled
        }
        if (action === 'reload') {
          if (!args.name) throw new Error('name is required for reload')
          return reload(args)
        }
        if (action === 'unload') {
          if (!args.name) throw new Error('name is required for unload')
          return unload(args)
        }
        if (action === 'release') {
          if (!args.name) throw new Error('name is required for release')
          const off = await unload(args)
          const gone = await uninstall(args)
          return { name: args.name, unload: off, uninstall: gone }
        }
        if (action === 'uninstall') {
          if (!args.name) throw new Error('name is required for uninstall')
          return uninstall(args)
        }
        throw new Error(`unknown action: ${action}`)
      }
      const startedAt = Date.now()
      const value = clean(await run())
      // Every answer carries its own cost, so a slow action is visible instead of felt.
      const total = Date.now() - startedAt
      if (value && typeof value === 'object' && !Array.isArray(value) && value.ms === undefined) value.ms = total
      recordTiming(action, total, {
        phases: value?.phases,
        enrichMs: value?.enrichMs,
        outcome: value?.reason ?? value?.rejected ?? value?.action ?? (value?.error ? 'error' : undefined),
      })
      if (timings.length % 10 === 0) void flushTimings()
      return value
    },
  }

  ctx.effect(() => {
    const dispose = ctx.tools.register(tool)

    // Opt this instance into the Settings UI. With auto:true the harness generates a page
    // from the Config schema above, so the ~20 knobs are editable without hand-editing
    // cordis.patch.yml. A failure here must not affect the tool.
    try {
      const settingsApi = ctx.get('settings')
      if (typeof settingsApi?.configure === 'function') disposeSettings = settingsApi.configure({ auto: true }, ctx.fiber)
    } catch {
      // no settings service in this composition
    }

    // Claude-style progressive disclosure: the skill body is read once at apply time and
    // handed to the skills registry, so only the one-line description enters the prompt.
    try {
      const skills = ctx.get('skills')
      const skillFile = new URL('./skills/lazy-plugins/SKILL.md', import.meta.url)
      const raw = readFileSync(skillFile, 'utf8')
      const parts = raw.split('---')
      const front = parts.length > 2 ? parts[1] : ''
      const pick = (key) => {
        const line = front.split('\n').find((item) => item.startsWith(key + ':'))
        return line ? line.slice(key.length + 1).trim() : undefined
      }
      if (skills?.register) {
        disposeSkill = skills.register({
          name: 'lazy-plugins',
          description: pick('description') ?? 'Find, install and call market plugins on demand.',
          whenToUse: pick('whenToUse'),
          content: parts.slice(2).join('---').trim(),
          invocation: { modelInvocable: true, userInvocable: true },
          provider: 'dsh-lazy-plugins',
          source: 'runtime',
        })
      }
    } catch (error) {
      // no skills service here: the tool still works on its own
      skillError = String(error?.message ?? error)
    }

    // Tell every session — not just this one — that a capability is usually a plugin away.
    // A prompt section is per-session cost, so it stays short and constant.
    try {
      const promptApi = ctx.get('systemPrompt')
      if (typeof promptApi?.section === 'function') {
        // The base text is symptom-keyed on purpose. The previous version listed *domains*
        // (video, PDF, sheets…), which a session fighting the same WPF type error three times
        // read as "an ordinary code edit" — the one case it tells the model to skip. A repeated
        // failure is the clearest capability-gap signal we can observe, so it is named here and,
        // when one is live, appended with its actual signature.
        const base = [
          'Before treating a problem as "just write the code", check two triggers for the plugin market',
          '(lazy_plugin):',
          '(a) capability gap — the task needs something this session cannot do: video, copywriting,',
          'images, TTS, PDF or spreadsheets, translation, session export, DB, deploy, browser automation,',
          'public-API lookups;',
          '(b) stuck loop — the same error or the same failed approach for the second time, a lookup that',
          '404s, a repo that is gone, a tool that cannot reach the target. Then stop patching:',
          'lazy_plugin action=ensure with one sentence of need and context="what already failed", or',
          'action=recipes for the verified shortlist (31 domains, no network).',
          'A plugin usually beats hand-written plumbing; load defaults to proxy, so the visible tool set',
          'and the prompt cache stay intact and the loaded tools are called through action=invoke.',
          'Leave it installed after the task — in proxy mode it costs no prompt space.',
          'Skip all of this for ordinary edits inside an existing project: no trigger, no lookup.',
        ].join(' ')
        disposePrompt = promptApi.section({
          name: 'lazy-plugins',
          order: 40,
          text: () => {
            const blocked = recentBlockedFailure()
            if (!blocked) return base
            return `${base} Live evidence: "${blocked.tool}" failed ${blocked.count} times with the same signature (${blocked.signature.slice(0, 90)}). Treat that as trigger (b) now.`
          },
        })
        promptSectionRegistered = true
      }
    } catch {
      // no prompt service: the tool and the skill still work
    }

    // A new agent gets the current mask; without this a plugin loaded earlier would be
    // visible again to a later session.
    const offAgent = ctx.on?.('agent/created', ({ agent }) => installRestriction(agent))
    // Evidence, not keywords: `tools/result` fires once per finished tool call, so a signature
    // that repeats is proof the current approach is stuck (audit of the WPF triple-failure case).
    const offToolResult = ctx.on?.('tools/result', (exec, result) => {
      try {
        noteFailure(exec, result)
      } catch {
        // the ledger only sharpens the trigger; it must never become a failure source
      }
    })

    // Trigger 1 — on every start: warm the resident plugins and refresh the index once.
    // Both run in the background; a slow or dead network must not delay boot.
    const bootWarm = async () => {
      // An app update silently denies plugins whose engines.dsh no longer admits the
      // running version (2026-11-08: dsh-ops@0.4.4 lost every ops_* tool this way).
      void verify().catch(() => {})
      await loadHidden()
      await refreshRestrictions()
      await warmResident()
      try {
        await refreshIndex()
      } catch {
        // serving the cached copy is the point; a failed refresh is not an error here
      }
      // Last: a package manager run should never delay the index or the mask.
      try {
        const result = await autoUpdatePool()
        if (result?.applied?.length) warmed = [...(warmed ?? []), { autoUpdate: result.applied }]
      } catch {
        // auto-update is a convenience; it never fails the boot path
      }
    }
    const bootTimer = setTimeout(() => { void bootWarm() }, Number(settings.bootDelayMs) || DEFAULTS.bootDelayMs)

    // Self-heal the browser row. The audit of crash-2026-11-09T08-00-18-154Z-web-boot.log
    // ("web boot: 1 entry did not activate / @local/dsh-lazy-plugins: loading") showed that a
    // row which is not settled before the renderer's start barrier takes the whole page down.
    // So the first attempt now runs inside apply() — before any timer — and the delayed passes
    // exist only to repair a stale "no client half" verdict from an earlier host start.
    try {
      ensureClientRow('boot')
    } catch {
      // best effort: the panel half is optional, the host half never depends on it
    }
    const healTimer = setTimeout(() => {
      try {
        ensureClientRow('boot')
      } catch {
        // best effort: the panel half is optional, the host half never depends on it
      }
    }, Number(settings.bootDelayMs) || DEFAULTS.bootDelayMs)
    if (typeof healTimer.unref === 'function') healTimer.unref()

    // Trigger 3 — daily fallback: whatever the user did or did not click, the cache is
    // revalidated once a day so a long-lived process never drifts far behind.
    const daily = setInterval(() => {
      void refreshIndex().catch(() => {})
    }, Number(settings.dailyRefreshMs) || DEFAULTS.dailyRefreshMs)
    if (typeof daily.unref === 'function') daily.unref()

    // Trigger 2 — when someone opens the plugin panel: the Web UI can hit this route.
    // `GET /lazy-plugins/refresh` refreshes the index and warms residents; throttled so a
    // panel that remounts in a loop cannot cause a request storm.
    let lastPanelRefresh = 0
    const route = ctx.get('webServer')?.register({
      kind: 'prefix',
      path: '/lazy-plugins',
      handler: async (req, res) => {
        const url = String(req.url ?? '')
        const send = (status, body) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(JSON.stringify(body))
        }
        try {
          if (url.startsWith('/lazy-plugins/state')) {
            // Read-only by default. `?repair=1` is the explicit opt-in that also repairs the
            // boot-graph row (a GET must not silently write into another service's state).
            const repair = /[?&]repair=1(&|$)/.test(url) ? ensureClientRow('state?repair=1') : undefined
            return send(200, { ...(await indexState()), repair })
          }
          if (url.startsWith('/lazy-plugins/api/list')) {
            return send(200, await panelRows())
          }
          if (url.startsWith('/lazy-plugins/api/act') && req.method === 'POST') {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            let body = {}
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            } catch {
              return send(400, { ok: false, error: 'invalid json' })
            }
            try {
              const result = await profileWrite(() => panelAct(body))
              return send(200, { ok: true, result })
            } catch (error) {
              return send(200, { ok: false, error: String(error?.message ?? error) })
            }
          }
          if (url.startsWith('/lazy-plugins/repair-client')) {
            // Explicit repair endpoint: the only way to fix a stale "no client half" verdict
            // without restarting the host. POST is preferred; GET is accepted for curl
            // convenience but is plainly idempotent and does nothing once the row is present.
            const repair = ensureClientRow(`repair-client:${req.method ?? 'GET'}`)
            return send(200, { ok: repair?.inGraphAfter !== false, repair, ...(await indexState()) })
          }
          if (!url.startsWith('/lazy-plugins/refresh')) return send(404, { error: 'unknown route' })
          // Who called: only the browser half sends `?src=mount|panel`. A bare curl proves
          // the route works but must not inflate the client-side count, so it is recorded
          // on the separate `lastRouteCall*` pair.
          let src = ''
          try {
            src = new URL(url, 'http://127.0.0.1').searchParams.get('src') || ''
          } catch {
            src = ''
          }
          lastRouteCallAt = Date.now()
          lastRouteCallSource = src || 'unknown'
          const fromClient = src === 'mount' || src === 'panel'
          // Every client-sourced call is recorded here, before the throttle: a throttled
          // call still proves the page ran `client.js`, it just did not refresh anything.
          if (fromClient) {
            clientRequests += 1
            lastPanelPingAt = lastRouteCallAt
            lastPanelPingSource = src
            const fingerprint = fingerprintOf(req)
            if (fingerprint.fromBrowser) {
              browserPings.count += 1
              browserPings.at = lastRouteCallAt
              browserPings.source = src
              browserPings.fingerprint = fingerprint
            }
          }
          const now = Date.now()
          if (now - lastPanelRefresh < (Number(settings.panelThrottleMs) || DEFAULTS.panelThrottleMs)) {
            // Throttled: no refresh, so `panelPings` (which counts refreshes) stays put.
            // The counters are echoed anyway, so a probe can tell "reached the route" from
            // "actually refreshed" without a second request.
            return send(200, { throttled: true, calledBy: lastRouteCallSource, ...(await indexState()) })
          }
          lastPanelRefresh = now
          if (fromClient) panelPings += 1
          const result = await refreshIndex()
          return send(200, {
            ...result,
            warmed,
            calledBy: lastRouteCallSource,
            panelPings,
            clientRequests,
            browserPings: browserPings.count,
            src: lastPanelPingSource,
          })
        } catch (error) {
          return send(500, { error: String(error?.message ?? error) })
        }
      },
    })

    return () => {
      loaded.clear()
      clearInterval(daily)
      clearTimeout(bootTimer)
      clearTimeout(healTimer)
      try { offAgent?.() } catch {}
      try { offToolResult?.() } catch {}
      try { disposeSkill?.() } catch {}
      try { disposeSettings?.() } catch {}
      try { disposePrompt?.() } catch {}
      void flushTimings()
      for (const dispose of restrictions.values()) { try { dispose() } catch {} }
      restrictions.clear()
      route?.()
      dispose()
    }
  })
}
