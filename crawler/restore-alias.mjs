// Restore real package names for entries an older crawler disambiguated by appending a
// counter (`dsh-fish` -> `dsh-fish-3`).
//
// Those names are not packages: `dsh-fish-3` is a 404 on every registry while `dsh-fish`
// resolves, so the row looks installable in the index and fails at install time. The suffix
// lives on in data/catalog.json, so filtering at build time does not help — the name has to
// be repaired.
//
// Rule: a name ending in `-<digits>` whose own registry probe failed, whose base name DOES
// resolve, is renamed to the base. If the base is already taken by another row, the two are
// merged (the richer row survives, labels and popularity are unioned).
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = join(root, 'dist', 'index.json')
const PROBE = join(root, 'data', 'npm-probe.json')
const CONCURRENCY = Number(process.env.ALIAS_CONCURRENCY || 24)
const TIMEOUT_MS = Number(process.env.ALIAS_TIMEOUT_MS || 8000)

const index = JSON.parse(await readFile(INDEX, 'utf8'))
const plugins = index.plugins ?? []
let probe = {}
try { probe = JSON.parse(await readFile(PROBE, 'utf8')) } catch { probe = {} }

const SUFFIX = /^(.*\D)-(\d{1,2})$/
const npmOk = (name) => {
  const entry = probe[name]
  return Boolean(entry) && (entry.npmmirror === 'ok' || entry.npmjs === 'ok')
}

const candidates = []
for (const plugin of plugins) {
  const match = SUFFIX.exec(String(plugin.name ?? ''))
  if (!match) continue
  const base = match[1]
  if (npmOk(plugin.name)) continue // the suffixed name is real, leave it alone
  candidates.push({ plugin, base })
}
console.log(`restore-alias: ${candidates.length} suffixed name(s) whose own probe failed; checking their base names`)

// One bounded prober, shared by both rename stages below. Same contract as
// probe-npm.mjs: HEAD against npmmirror then npmjs, 8 s timeout, results cached in
// data/npm-probe.json. Callers decide what counts as "already resolved".
async function resolveNames(names, resolved) {
  const unknown = [...new Set(names)].filter((name) => !resolved(probe[name]))
  if (!unknown.length) return 0
  let cursor = 0
  let checked = 0
  async function worker() {
    while (cursor < unknown.length) {
      const name = unknown[cursor++]
      const result = { checkedAt: new Date().toISOString() }
      for (const [id, url] of [
        ['npmmirror', `https://registry.npmmirror.com/${name.replace('/', '%2F')}`],
        ['npmjs', `https://registry.npmjs.org/${name.replace('/', '%2F')}`],
      ]) {
        try {
          const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'dsh-market-alias' } })
          result[id] = res.status === 200 ? 'ok' : res.status === 404 ? 'missing' : `http-${res.status}`
        } catch {
          result[id] = 'error'
        }
        if (result[id] === 'ok') break
      }
      probe[name] = result
      checked++
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unknown.length) }, worker))
  return checked
}

// Resolve the base names that the probe has never seen.
const checked = await resolveNames(candidates.map((c) => c.base), (entry) => Boolean(entry))
if (checked) console.log(`  probed ${checked} base name(s)`)

const byName = new Map(plugins.map((plugin) => [plugin.name, plugin]))
let renamed = 0
let merged = 0
const drop = new Set()

for (const { plugin, base } of candidates) {
  if (!npmOk(base)) continue
  const existing = byName.get(base)
  if (existing && existing !== plugin) {
    // Keep the richer row: engines > publish date > more sources > more stars.
    const score = (p) => (p.versions?.[0]?.engines?.dsh ? 8 : 0) + (p.versions?.[0]?.publishTimestamp ? 4 : 0)
      + Math.min(4, (p.metadata?.labels ?? []).filter((l) => String(l).startsWith('src-')).length)
      + Math.min(2, Math.log10(1 + (p.metadata?.sortKeys?.stars ?? 0)))
    const [keep, lose] = score(plugin) > score(existing) ? [plugin, existing] : [existing, plugin]
    const labels = new Set([...(keep.metadata?.labels ?? []), ...(lose.metadata?.labels ?? [])])
    keep.metadata = { ...keep.metadata, labels: [...labels] }
    keep.versions ??= []
    keep.versions[0] ??= {}
    if (!keep.versions[0].engines?.dsh && lose.versions?.[0]?.engines?.dsh) keep.versions[0].engines = lose.versions[0].engines
    if (!keep.versions[0].publishTimestamp && lose.versions?.[0]?.publishTimestamp) keep.versions[0].publishTimestamp = lose.versions[0].publishTimestamp
    byName.set(base, keep)
    if (lose !== keep) drop.add(lose)
    merged++
    continue
  }
  // No collision: rename in place and let the probe record follow it.
  plugin.name = base
  probe[base] ??= { checkedAt: new Date().toISOString(), npmmirror: 'ok' }
  byName.delete(String(plugin.name))
  byName.set(base, plugin)
  renamed++
}

// Second half of the same defect, reached through `title`: the row's own name 404s
// and the only surviving copy of the real package name is `title` (often scoped, e.g.
// "dsh-fish-3" -> "@someone/dsh-fish"), so the base-name rule above cannot help — its
// base is not a package at all. The shape is proved structurally (name = unscoped title
// + "-<digits>"); the registry still decides, so a row is renamed only when its name is
// MISSING and its title answers 200 on a registry. Anything else — both dead, a title
// whose row already exists, or a probe we could not complete — is left untouched, so an
// unreachable registry can never turn a working name into a dead one.
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const unscoped = (name) => name.slice(name.indexOf('/') + 1)
const TITLE_TTL_DAYS = Number(process.env.ALIAS_TITLE_TTL_DAYS || 3)
const freshEnough = (entry) => Boolean(entry) && Date.now() - Date.parse(entry.checkedAt ?? 0) < TITLE_TTL_DAYS * 86400000
const stateOf = (entry) => {
  if (!entry) return null
  if (entry.npmmirror === 'ok' || entry.npmjs === 'ok') return 'ok'
  if (entry.npmmirror === 'error' || entry.npmjs === 'error') return 'error'
  if (entry.npmmirror === 'missing' || entry.npmjs === 'missing') return 'missing'
  return null
}

const titleCandidates = []
for (const plugin of index.plugins) {
  if (drop.has(plugin)) continue
  const match = SUFFIX.exec(String(plugin.name ?? ''))
  if (!match) continue // only the dedupe shape is in scope, never a hand-picked list
  const title = typeof plugin.title === 'string' ? plugin.title : plugin.title?.en
  if (!title || title === plugin.name || !NPM_NAME.test(title)) continue
  if (unscoped(title) !== unscoped(match[1])) continue
  titleCandidates.push({ plugin, title })
}

// Bounded: only the candidates above (and their titles) are ever probed. The catalogue
// is never swept, and cached answers younger than TITLE_TTL_DAYS are reused.
const probedTitles = await resolveNames(
  titleCandidates.flatMap((candidate) => [candidate.plugin.name, candidate.title]),
  (entry) => freshEnough(entry),
)
if (probedTitles) console.log(`  probed ${probedTitles} title candidate(s)`)

let retitled = 0
let titlePending = 0
let titleUnusable = 0
for (const { plugin, title } of titleCandidates) {
  if (drop.has(plugin)) continue
  const nameState = stateOf(probe[plugin.name])
  const titleState = stateOf(probe[title])
  if (nameState === 'ok') continue // the suffixed name is a real package: leave it
  if (nameState !== 'missing' || titleState !== 'ok') {
    if (nameState === 'missing') titleUnusable++ // both dead, or a title we cannot confirm
    else titlePending++ // no usable answer for the name: data untouched
    continue
  }
  const owner = byName.get(title)
  if (owner && owner !== plugin) { titleUnusable++; continue } // another row already owns it
  const previous = String(plugin.name)
  plugin.name = title
  const labels = new Set([...(plugin.metadata?.labels ?? []), 'alias-of'])
  plugin.metadata = { ...plugin.metadata, labels: [...labels] }
  probe[title] = { ...(probe[title] ?? {}), checkedAt: new Date().toISOString(), renamedFrom: previous }
  byName.delete(previous)
  byName.set(title, plugin)
  renamed++
  retitled++
}

if (titlePending) console.log(`restore-alias: PENDING ${titlePending} title fallback(s) — no usable registry answer, data untouched`)
if (retitled || titleUnusable) console.log(`restore-alias: title fallback renamed ${retitled}, left ${titleUnusable} unusable candidate(s)`)

if (renamed || merged) {
  index.plugins = plugins.filter((plugin) => !drop.has(plugin))
  await writeFile(INDEX, JSON.stringify(index) + '\n')
  await writeFile(PROBE, JSON.stringify(probe) + '\n')
}
console.log(`restore-alias: renamed ${renamed}, merged ${merged} duplicate(s), dropped ${drop.size} row(s)`)
