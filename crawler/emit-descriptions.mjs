// Publishes the Chinese one-line descriptions as their own small document:
// `dist/descriptions.zh.json`, mirrored to `site/descriptions.zh.json` because
// GitHub Pages serves `site/`.
//
// WHY THIS EXISTS
// The published language documents are metadata-only: `site/index.zh.json`
// (2,829,964 B, 10,559 entries) and `dist/index.zh.json` carry `name`, `metadata`
// and `versions` and nothing else — zero descriptions. The full format-1 document
// `dist/index.json` still carries one per plugin (10,577 of 10,577 today), so a
// client that wants the text has to download that 8.8 MB document and build a map,
// or reach for a stale 4 MB copy of `index.zh.json` that happens to be on the CDN.
// A map of name -> zh description costs ~1/10th of that and is the only thing such
// a client actually needs.
//
// WHY IT READS SEVERAL SOURCES
// The slim language documents are what the crawl publishes for DSH, so the
// descriptions may move between them in future runs (a slim document that keeps the
// description is smaller than this sidecar). Every source that exists is read and
// merged per name, first writer wins, so the sidecar keeps working either way and
// reports which file actually contributed.
//
//   node crawler/emit-descriptions.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Full format-1 first: it is the document that carries descriptions today.
const SOURCES = ['dist/index.json', 'site/index.zh.json', 'dist/index.zh.json']
const OUT = ['dist/descriptions.zh.json', 'site/descriptions.zh.json']

const pickZh = (description) => {
  if (typeof description === 'string') return description.trim()
  const zh = description?.zh
  return typeof zh === 'string' ? zh.trim() : ''
}

const descriptions = new Map()
const sources = []
let primary = null
let scanned = 0
let skippedNoZh = 0

for (const rel of SOURCES) {
  const file = join(root, rel)
  if (!existsSync(file)) continue
  let document
  try {
    document = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    // A half-written document is not a reason to fail the build.
    continue
  }
  const plugins = document.plugins ?? []
  scanned += plugins.length
  let added = 0
  for (const plugin of plugins) {
    const name = String(plugin.name ?? '')
    if (!name) continue
    const zh = pickZh(plugin.description)
    if (!zh) {
      if (!descriptions.has(name)) skippedNoZh++
      continue
    }
    if (descriptions.has(name)) continue
    descriptions.set(name, zh)
    added++
  }
  sources.push({ source: rel, entries: plugins.length, added })
  if (added && !primary) primary = rel
}

// Code-unit order, not locale order: the same input must give the same bytes on
// every runner, because the file is compared and cached by content.
const sorted = Object.fromEntries([...descriptions.keys()].sort().map((name) => [name, descriptions.get(name)]))
const body = JSON.stringify({
  schema: 1,
  generatedAt: new Date().toISOString(),
  source: primary,
  sources,
  count: descriptions.size,
  descriptions: sorted,
})
for (const rel of OUT) await writeFile(join(root, rel), body)

const gzip = gzipSync(Buffer.from(body)).length
console.log(`entries   ${scanned} scanned, ${descriptions.size} with a zh description, ${skippedNoZh} without`)
console.log(`sources   ${sources.map((s) => `${s.source}(${s.added})`).join(' ')}`)
console.log(`bytes     ${Buffer.byteLength(body)} raw / ${gzip} gzip`)
console.log(`written   ${OUT.join(', ')}`)
