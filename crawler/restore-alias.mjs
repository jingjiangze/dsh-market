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
import { reconcileEnginesLabel } from './labels.mjs'
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

// Resolve the base names that the probe has never seen.
const unknown = [...new Set(candidates.map((c) => c.base))].filter((base) => !probe[base])
let cursor = 0
let checked = 0
async function worker() {
  while (cursor < unknown.length) {
    const base = unknown[cursor++]
    let result = { checkedAt: new Date().toISOString() }
    for (const [id, url] of [
      ['npmmirror', `https://registry.npmmirror.com/${base.replace('/', '%2F')}`],
      ['npmjs', `https://registry.npmjs.org/${base.replace('/', '%2F')}`],
    ]) {
      try {
        const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'dsh-market-alias' } })
        result[id] = res.status === 200 ? 'ok' : res.status === 404 ? 'missing' : `http-${res.status}`
      } catch {
        result[id] = 'error'
      }
      if (result[id] === 'ok') break
    }
    probe[base] = result
    checked++
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unknown.length || 1) }, worker))
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

index.plugins = plugins.filter((plugin) => !drop.has(plugin))
// A merge unions both rows' labels but adopts the richer row's engines, so the pair can
// end up contradicting itself: `no-engines` sitting next to a real `engines.dsh`
// range, which validate.mjs rejects. Reconcile here — unconditionally, because an
// earlier run may already have persisted the contradiction and this is the last writer
// before the gate.
const enginesFixed = reconcileEnginesLabel(index.plugins)
if (renamed || merged || enginesFixed) {
  await writeFile(INDEX, JSON.stringify(index) + '\n')
  await writeFile(PROBE, JSON.stringify(probe) + '\n')
}
if (enginesFixed) console.log(`restore-alias: reconciled no-engines on ${enginesFixed} row(s)`)
console.log(`restore-alias: renamed ${renamed}, merged ${merged} duplicate(s), dropped ${drop.size} row(s)`)
