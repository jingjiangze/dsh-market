// How far behind the upstream catalogues are we?
//
// A source's own size says nothing about sync: `record.hintSource ??= label` keeps only the
// FIRST catalogue that saw a name, so an entry carried by two sources is counted once and the
// per-source counts under-report growth. The question a reader actually cares about — "is the
// new plugin out yet" — is answered by which upstream NAMES are absent from this build.
//
// Runs after the index is assembled and prints one line per source. It never fails the build:
// between a 3-hourly crawl and continuously published catalogues, a small gap is the normal
// state, and failing on it would just produce a red pipeline that means nothing.
//
//   node crawler/sync-report.mjs
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TIMEOUT_MS = Number(process.env.SYNC_TIMEOUT_MS || 120000)

const SOURCES = [
  ['official', process.env.OFFICIAL_INDEX || 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json'],
  ['polang', process.env.POLANG_INDEX || 'https://polang233.github.io/dsh-plugin-index/index.json'],
  ['dshso', process.env.DSHSO_INDEX || 'https://cdn.dsh.so/market/index.json'],
  ['mydsh', process.env.MYDSH_INDEX || 'https://www.mydsh.xyz/market/index.json'],
]

// npm's own rule for a publishable name, matching crawler/sources.mjs and the format-1
// validator: lowercase, URL-safe, optionally scoped.
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const looksInstalable = (name) => NPM_NAME.test(name) && name.length <= 214

// A row's installable package is not always its `name`: several catalogues list a repository
// and put the npm specs in `packages.targets[]`. Read both, the way the crawler does.
function namesOf(row) {
  const out = new Set()
  const direct = String(row?.name ?? row?.package ?? '').toLowerCase()
  if (looksInstalable(direct)) out.add(direct)
  for (const target of row?.packages?.targets ?? []) {
    const spec = String(target?.source ?? target?.install ?? '').trim()
    const bare = spec.startsWith('npm:') ? spec.slice(4) : spec
    const hit = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(?:@.+)?$/u.exec(bare)
    if (hit && looksInstalable(hit[1])) out.add(hit[1].toLowerCase())
  }
  return [...out]
}

const index = JSON.parse(await readFile(join(root, 'dist', 'index.json'), 'utf8'))
const have = new Set((index.plugins ?? []).map((p) => String(p.name ?? '').toLowerCase()))
console.log(`sync: local build carries ${have.size} names`)

const fetchJson = async (url) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (res.ok) return JSON.parse(await res.text())
      if (res.status >= 400 && res.status < 500) return null
    } catch { /* timeout or reset: retry */ }
    await new Promise((r) => setTimeout(r, 2000 * attempt))
  }
  return null
}

let worst = 0
for (const [name, url] of SOURCES) {
  const doc = await fetchJson(url)
  if (!doc) { console.log(`sync: ${name.padEnd(9)} unreachable — not measured`); continue }
  const rows = doc.plugins ?? doc.entries ?? []
  // Both sides read the installable package the same way, so the delta is real:
  const names = [...new Set(rows.flatMap(namesOf))]
  const missing = names.filter((n) => !have.has(n))
  const rejected = rows.length - names.length
  worst = Math.max(worst, missing.length)
  const pct = names.length ? ((missing.length / names.length) * 100).toFixed(1) : '0.0'
  console.log(`sync: ${name.padEnd(9)} (${rejected} upstream rows are not installable names)`)
  console.log(`sync: ${name.padEnd(9)} upstream ${String(names.length).padStart(6)} · missing here ${String(missing.length).padStart(5)} (${pct}%)`
    + (missing.length ? ` e.g. ${missing.slice(0, 3).join(', ')}` : ''))
}

// A large and widening gap means the source fetch is failing inside the crawl, not that
// upstream published a lot in three hours.
if (worst > 400) console.log(`::warning::sync gap reached ${worst} names on one source — check that source's fetch in the build log`)
