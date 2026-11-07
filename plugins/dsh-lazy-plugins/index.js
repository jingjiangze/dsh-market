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
import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collapse, expandTerms, sameFamily, termsOf } from './lib/ranking.mjs'

export const inject = ['tools']

export const name = 'dsh-lazy-plugins'

// Reported by `list` so a live instance can be told apart from a stale one after an
// upgrade (a linked bundle is re-imported only when the row restarts).
const VERSION = '3.16.0'

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
  description: typeof entry.description === 'string' ? entry.description : textOfLocalized(entry.description),
  descriptionSource: entry.descriptionSource,
})

const textOfLocalized = (value) => {
  if (!value) return undefined
  if (typeof value === 'string') return value
  return value.zh ?? value.en ?? Object.values(value)[0]
}

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
    if (!api) return null
    const indexes = api.listIndexes() ?? []
    if (config.indexUrl) {
      const wanted = indexes.find((item) => item.url === config.indexUrl)
      if (wanted) return wanted.url
    }
    return indexes[0]?.url ?? null
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

  const readIndex = async (url) => {
    const memory = indexCache.get(url)
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
      return entry.document
    } catch (error) {
      if (onDisk?.document) {
        indexCache.set(url, onDisk)
        return onDisk.document
      }
      throw error
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

  // Extract into the cache and return the package root (the archive has one top directory).
  const extractArchive = async (name, sha, buffer) => {
    const { mkdtemp, writeFile: writeFileRaw } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { spawnSync } = await import('node:child_process')
    const base = join(cacheDir(), 'git', `${String(name).replace(/[^a-z0-9._-]+/gi, '-')}-${sha.slice(0, 8)}`)
    await mkdir(base, { recursive: true })
    const archive = join(base, 'source.tar.gz')
    await writeFileRaw(archive, buffer)
    const out = join(base, 'src')
    await mkdir(out, { recursive: true })
    const result = spawnSync('tar', ['-xzf', archive, '-C', out], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error('tar failed: ' + String(result.stderr ?? '').slice(0, 200))
    const { readdir } = await import('node:fs/promises')
    const top = (await readdir(out, { withFileTypes: true })).find((entry) => entry.isDirectory())
    if (!top) throw new Error('archive has no top directory')
    return join(out, top.name)
  }

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

  // Short memory of picks that did not work out, so `ensure` does not offer them again.
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

    if (declaredBase) {
      // Phase 1: every candidate name against the declared registry, in parallel. Measured
      // hits answer in 70-232 ms, so this settles the common case inside one short budget
      // instead of paying a serial round of 1.5 s.
      const first = await Promise.all(names.map(async (packageName) => ({
        package: packageName,
        registry: declaredBase,
        state: await probeOnce(urlOf(declaredBase, packageName), settings.probeFastMs),
      })))
      checked.push(...first)
      const hit = first.find((item) => item.state === 'ok')
      if (hit) return { verdict: 'ok', package: hit.package, registry: declaredBase, checked, fast: true }
    }

    const registries = [declaredBase, REGISTRY_DEFAULT, ...(settings.registryFallbacks ?? [])].filter(
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

  const loadDescriptionMap = async () => {
    const ttl = Number(settings.descriptionTtlMs) || DEFAULTS.descriptionTtlMs
    // Free path first: if the index we already hold is description-rich, project it instead
    // of paying for a separate sidecar fetch.
    try {
      const indexUrl = pickIndexUrl()
      if (indexUrl) {
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

  const enrich = async (rows) => {
    if (!settings.enrichDescriptions) return rows
    const pending = rows.filter((row) => row && !row.description)
    if (!pending.length) return rows
    const map = await loadDescriptionMap()
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
    const text = [row?.name, row?.title, row?.description].filter((item) => typeof item === 'string').join(' ')
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
      const enriched = await enrich(rows)
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
    const fieldsOf = (plugin) => ({
      name: String(plugin.name ?? '').toLowerCase(),
      title: String(textOfLocalized(plugin.title) ?? '').toLowerCase(),
      description: String(map.get(plugin.name) ?? textOfLocalized(plugin.description) ?? '').toLowerCase(),
    })
    const cache = new Map()
    for (const plugin of plugins) {
      const fields = fieldsOf(plugin)
      cache.set(plugin.name, fields)
      const haystack = fields.name + ' ' + fields.title + ' ' + fields.description
      for (const term of terms) if (haystack.includes(term)) documentFrequency.set(term, documentFrequency.get(term) + 1)
    }
    const total = Math.max(plugins.length, 1)
    const idfOf = (term) => Math.log(1 + total / (1 + (documentFrequency.get(term) ?? 0)))
    const scored = []
    for (const plugin of plugins) {
      const fields = cache.get(plugin.name) ?? fieldsOf(plugin)
      let score = 0
      for (const term of terms) {
        const weight = idfOf(term) * (bridgedTerms.has(term) ? BRIDGE_WEIGHT : 1)
        if (fields.name.includes(term)) score += weight * 3
        if (fields.title.includes(term)) score += weight * 2
        if (fields.description.includes(term)) score += weight * 2
      }
      if (score > 0) {
        const risks = setupRisksOf({ name: fields.name, title: fields.title, description: fields.description })
        const penalty = risks.length ? (Number(settings.setupRiskPenalty) || DEFAULTS.setupRiskPenalty) : 1
        scored.push({ plugin, score: Math.round(score * penalty * 100) / 100, risks })
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
    const enriched = await enrich(rows)
    const usable = enriched.filter((row) => row.installable !== false)
    const entries = collapse(usable).slice(0, limit)
    const consumed = rows.length
    return {
      index: url,
      terms: terms.slice(0, 8),
      candidates: scored.length,
      offset,
      nextOffset: scored.length > offset + consumed ? offset + consumed : undefined,
      uninstallableHidden: enriched.length - usable.length || undefined,
      entries,
    }
  }

  // 'Find me whatever does X' in one call: suggest, then load the winner when the ranking is
  // decisive. Anything ambiguous comes back as candidates, so a human/agent decides.
  const ensure = async (args) => {
    const need = args.need ?? args.task ?? args.query
    if (!String(need ?? '').trim()) throw new Error('need is required for ensure')
    const shortlist = await suggest({ task: need, limit: Math.min(Math.max(Number(args.limit) || 5, 1), 10) })
    const entries = shortlist.entries ?? []
    // Skip packages that failed a few days ago: repeating the same pick is the most
    // expensive mistake this tool can make.
    const failed = await readFailed()
    const viable = entries.filter((entry) => !failureIsFresh(failed[entry.name]))
    const skipped = entries.length - viable.length
    const [first, second] = viable
    if (!first) return { need, action: 'none', skippedRecentFailures: skipped || undefined, candidates: [] }
    if (first.installed === 'installed') return { need, action: 'already-installed', pick: first, candidates: entries }
    const score = Number(first.matchScore) || 0
    const runnerUp = Number(second?.matchScore) || 0
    const floor = Number(settings.autoSelectScore) || DEFAULTS.autoSelectScore
    const margin = Number(settings.autoSelectMargin) || DEFAULTS.autoSelectMargin
    const family = sameFamily(first, second)
    const decisive = score >= floor && (!runnerUp || score >= runnerUp * margin || (family && settings.autoSelectFamilyExempt === true))
    if (!decisive) {
      return {
        need,
        action: 'needs-choice',
        reason: `top score ${score} (floor ${floor})${runnerUp ? `, margin ${(score / runnerUp).toFixed(2)}x (needs ${margin}x)` : ''}${family ? ', runner-up is the same family' : ''}`,
        skippedRecentFailures: skipped || undefined,
        // Same-family runner-up: narrow the choice to the two real options instead of 5 rows.
        familyCandidates: family ? viable.filter((row) => sameFamily(first, row)).slice(0, 2) : undefined,
        candidates: viable,
      }
    }
    if (args.auto === false || settings.autoSelectEnabled === false) return { need, action: 'would-load', pick: first, skippedRecentFailures: skipped || undefined, candidates: viable }
    const loaded = await load({ name: first.name, activate: 'proxy', keep: args.keep })
    return { need, action: loaded.rejected ? 'rejected' : 'loaded', pick: first, skippedRecentFailures: skipped || undefined, candidates: viable, load: loaded }
  }

  const load = async (args) => {
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
        return { name: args.name, version: found.version, installedAs: found.name, alreadyInstalled: true, enabled: true, activated: true, ms: Date.now() - started }
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
          await refreshRestrictions()
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
      let probe
      let spec = target.spec
      const aliases = aliasNamesOf(entry)
      // A git/github spec is not served by any npm registry, so the probe would always say
      // 'absent'; skip it for those and let the archive route decide.
      if (settings.verifyInstall && !/^(git+|github:)/.test(String(target.spec))) {
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
        if (probe.verdict === 'ok' && probe.registry) registry = probe.registry
        // The index renamed a duplicate: install the package name kept in `title`.
        if (probe.verdict === 'ok' && probe.package && probe.package !== args.name) {
          spec = `${probe.package}@${chosen.version}`
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
              const root = await extractArchive(args.name, sha, archive.buffer)
              spec = 'link:' + root.replace(/\\/g, '/')
              archiveUsed = { mirror: archive.url, ms: archive.ms, bytes: archive.buffer.length }
            } catch (error) {
              archiveUsed = { mirror: archive.url, error: String(error?.message ?? error) }
            }
          } else {
            archiveUsed = { error: 'no mirror answered within the budget' }
          }
        }
      }
      const beforeBundles = (await api.listBundles().catch(() => [])) ?? []
      const beforeToolsAll = visibleToolNames()
      const beforeSkills = await skillNameSet()
      const applied = await api.installBundle(spec, {
        enabled: activate !== 'session',
        registry,
        requestId: args.requestId,
      })
      mark('install', lap)
      // What the install actually added: real bundle names, tools and skills.
      const known = new Set(beforeBundles.map((bundle) => bundle.name))
      const afterBundles = applied.application === 'applied' ? (await api.listBundles().catch(() => [])) ?? [] : []
      const addedBundles = afterBundles.filter((bundle) => !known.has(bundle.name)).map((bundle) => bundle.name)
      const addedSkills = [...(await skillNameSet())].filter((name) => !beforeSkills.has(name))
      const addedTools = [...visibleToolNames()].filter((name) => !beforeToolsAll.has(name))
      // The bundle name is the only handle the manager accepts; remember the mapping.
      const realBundle = addedBundles[0] ?? args.name
      if (applied.application === 'applied' && realBundle !== args.name) installedUnder.set(args.name, realBundle)
      const usable = addedTools.length > 0 || addedSkills.length > 0
      if (applied.application === 'applied' && !usable && args.keep !== true) {
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
      if (applied.error) await recordFailure(args.name, chosen.version, String(applied.error?.code ?? 'install-failed'))
      let proxied = []
      if (activate === 'proxy' && applied.application === 'applied') {
        proxied = [...visibleToolNames()].filter((name) => !beforeProxied?.has(name))
        for (const name of proxied) hiddenTools.add(name)
        await saveHidden()
        await refreshRestrictions()
        if (beforeProxied) watchLateRegistrations(beforeProxied)
      }
      return { skipped: false, applied, registry, probe, spec, proxied, archiveUsed, addedBundles, addedTools, addedSkills, usable }
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
      archive: result.archiveUsed,
      installedBundles: result.addedBundles?.length ? result.addedBundles : undefined,
      addedTools: result.addedTools?.length ? result.addedTools : undefined,
      addedSkills: result.addedSkills?.length ? result.addedSkills : undefined,
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
  const readPool = async () => {
    try {
      const parsed = JSON.parse(await readFile(poolPath(), 'utf8'))
      return Array.isArray(parsed?.names) ? parsed.names : []
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
  const residency = async (name) => {
    const bundles = await manager()?.listBundles().catch(() => []) ?? []
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
    const result = await api.setBundleEnabled(real, false)
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
    const result = await api.removeBundle(real)
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

  const installRestriction = (agent, liveNames) => {
    const known = liveNames ?? visibleToolNames()
    const names = [...hiddenTools].filter((name) => known.has(name))
    if (!names.length) return
    if (!agent?.ctx?.tools?.restrict) return
    try {
      restrictions.get(agent.id)?.()
    } catch {
      // a stale disposer is harmless
    }
    try {
      restrictions.set(agent.id, agent.ctx.tools.restrict({ deny: names }))
    } catch {
      // a failed mask keeps the previous one in place
    }
  }

  const refreshRestrictions = async () => {
    const known = visibleToolNames()
    let pruned = false
    for (const name of [...hiddenTools]) {
      if (known.has(name)) continue
      hiddenTools.delete(name)
      pruned = true
    }
    if (pruned) await saveHidden()
    const registry = ctx.get('agents')
    for (const agent of registry?.list?.() ?? []) installRestriction(agent, known)
  }

  const visibleToolNames = () => new Set((ctx.tools?.schemas?.() ?? []).map((schema) => schema.name))

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
    const result = await ctx.tools.execute({
      callId: (exec?.callId ? String(exec.callId) + '-sub' : 'sub-' + Date.now()),
      name,
      arguments: args.arguments ?? {},
      signal: exec?.signal ?? new AbortController().signal,
    })
    if (result?.isError) return { tool: name, error: result.error?.message, code: result.error?.info?.code, hint: 'run list to see which packages are loaded; a plugin must be loaded before its tools can be invoked' }
    return { tool: name, value: result?.value }
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
      const where = await residency(bundle.name)
      if (where.kind === 'auto' && !bundle.enabled) suggestions.push(`${bundle.name}: frequent use (score ${where.score}) but disabled — enable as resident`)
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
        // The host-wide view, for comparison: the agent view is what the model sees.
        countGlobal: (ctx.tools?.schemas?.() ?? []).length,
      },
      cache: { ...stats, index },
      usage: usageRows,
      pool: { autoInstalled: (await readPool()).length, recentFailures: Object.keys(await readFailed()).length },
      skillError,
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
      const where = await residency(bundle.name)
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

  // Add names to dsh.profile.bundles so the next boot composes them. This is the only
  // path that changes the tool set at a boundary where no cache is warm.
  const promoteToBundles = async (names) => {
    const dir = profileDir()
    if (!dir) return { promoted: [], reason: 'profile-not-found' }
    const manifestPath = join(dir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const bundles = manifest?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) return { promoted: [], reason: 'no-bundle-list' }
    const promoted = names.filter((name) => !bundles.includes(name))
    if (!promoted.length) return { promoted: [], reason: 'already-listed' }
    manifest.dsh.profile.bundles = [...bundles, ...promoted]
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    return { promoted, profile: dir }
  }

  const drainPending = async () => {
    const api = manager()
    if (!api) return
    const names = await readPending()
    if (!names.length) return
    const actions = []
    const failed = []
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    for (const item of names) {
      const name = item.name
      const attemptEnable = async () => {
        const direct = await api.setBundleEnabled(name, true).catch((error) => ({ error: { code: String(error?.message ?? error) } }))
        if (!direct.error || !item.version) return direct
        return api.installBundle(item.name + '@' + item.version, { enabled: true, registry: item.registry })
          .catch((error) => ({ error: { code: String(error?.message ?? error) } }))
      }
      let result = await attemptEnable()
      for (let attempt = 1; result.error && attempt <= 2; attempt += 1) {
        await wait(1500 * attempt)
        result = await attemptEnable()
      }
      if (result.error) {
        // Keep it queued: a failed enable during startup must be retried next activation,
        // not silently dropped.
        failed.push(item)
        actions.push({ name, state: 'error:' + result.error.code })
        continue
      }
      loaded.add(name)
      actions.push({ name, state: 'enabled' })
    }
    if (failed.length) {
      const promotion = await promoteToBundles(failed.map((item) => item.name))
      warmed = [...(warmed ?? []), { promotion }]
      if (promotion.promoted.length) {
        // Composed on the next boot; the queue has done its job.
        failed.length = 0
      }
    }
    await writePending(failed)
    warmed = [...(warmed ?? []), ...actions]
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
          enum: ['search', 'suggest', 'ensure', 'resolve', 'load', 'reload', 'unload', 'release', 'uninstall', 'list', 'refresh', 'advise', 'invoke'],
          description: 'What to do.',
        },
        name: { type: 'string', description: 'Exact package name (resolve/load/reload/unload/release/uninstall).' },
        query: { type: 'string', description: 'Keyword for search.' },
        task: { type: 'string', description: 'suggest: one sentence describing what the task needs.' },
        need: { type: 'string', description: 'ensure: the capability you need, in one sentence; it installs the best match when the ranking is decisive.' },
        auto: { type: 'boolean', description: 'ensure: set false to only report what it would load.' },
        keep: { type: 'boolean', description: 'load: keep the package even when it exposes neither tools nor skills.' },
        version: { type: 'string', description: 'Exact version; defaults to the newest.' },
        limit: { type: 'number', description: 'search rows, 1-40, default 10.' },
        offset: { type: 'number', description: 'search/suggest: skip this many candidates; use nextOffset from the previous page.' },
        tool: { type: 'string', description: 'invoke: tool name to run through the proxy.' },
        arguments: { type: 'object', description: 'invoke: arguments for that tool.', additionalProperties: true },
        activate: {
          type: 'string',
          enum: ['now', 'session', 'proxy'],
          description: 'load: proxy (recommended) activates the plugin but hides its tools from the model and runs them through the invoke action, so the visible tool set — and the prompt cache — never change; now activates visibly; session only installs.',
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
          return load(args)
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
      return clean(await run())
    },
  }

  ctx.effect(() => {
    const dispose = ctx.tools.register(tool)

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

    // A new agent gets the current mask; without this a plugin loaded earlier would be
    // visible again to a later session.
    const offAgent = ctx.on?.('agent/created', ({ agent }) => installRestriction(agent))

    // Trigger 1 — on every start: warm the resident plugins and refresh the index once.
    // Both run in the background; a slow or dead network must not delay boot.
    const bootWarm = async () => {
      await loadHidden()
      await refreshRestrictions()
      await warmResident()
      try {
        await refreshIndex()
      } catch {
        // serving the cached copy is the point; a failed refresh is not an error here
      }
    }
    const bootTimer = setTimeout(() => { void bootWarm() }, Number(settings.bootDelayMs) || DEFAULTS.bootDelayMs)

    // Self-heal the browser row once at startup as well: if this host started before the
    // package declared `dsh.client`, the module registry cached a stale "no client half"
    // verdict and the row is missing from the boot graph until someone asks for it.
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
      try { disposeSkill?.() } catch {}
      for (const dispose of restrictions.values()) { try { dispose() } catch {} }
      restrictions.clear()
      route?.()
      dispose()
    }
  })
}
