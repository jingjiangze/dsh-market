// Publish the untruncated descriptions as their own document.
//
// Why a sidecar and not a longer index: site/index.<lang>.json is fetched by every reader on
// first load, and its description is capped at 20 characters to keep that fetch small
// (DESC_MAX in lang-index.mjs). Search needs the opposite: more text per row. Rather than grow
// the document everyone pays for, retrieval-oriented clients fetch this file once and keep it
// beside the index.
//
// Shape (stable, format 1 style):
//   { format: 'dsh-plugin-descriptions', generatedAt, lang, max, descriptions: { [name]: text } }
//
// Written to:
//   dist/descriptions.<lang>.json   full source, uploaded to the dataset
//   site/descriptions.<lang>.json   committed, served by GitHub Pages / the brand domain
//
//   node crawler/plugin-descriptions.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = join(root, 'dist', 'index.json')
const LANGS = ['en', 'zh']
const MAX = Number(process.env.DESCRIPTION_MAX ?? 160)

const index = JSON.parse(await readFile(INDEX, 'utf8'))
const plugins = index.plugins ?? []

const pick = (value, lang) => {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  return String(value[lang] ?? value.en ?? Object.values(value).find((entry) => typeof entry === 'string') ?? '')
}

const report = []
for (const lang of LANGS) {
  const descriptions = {}
  let kept = 0
  for (const plugin of plugins) {
    const name = String(plugin.name ?? '')
    if (!name) continue
    const text = pick(plugin.description, lang).trim()
    if (!text) continue
    // The index is the reader's view; this is the retriever's. Cap it so the document stays a
    // few MB, but far above the 20 the index carries.
    descriptions[name] = text.slice(0, MAX)
    kept += 1
  }
  const document = {
    format: 'dsh-plugin-descriptions',
    schema: 1,
    lang,
    generatedAt: new Date().toISOString(),
    max: MAX,
    source: 'dist/index.json',
    count: kept,
    descriptions,
  }
  const json = JSON.stringify(document)
  for (const target of [join(root, 'dist', `descriptions.${lang}.json`), join(root, 'site', `descriptions.${lang}.json`)]) {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, json)
  }
  report.push({ lang, rows: kept, bytes: json.length })
  console.log(`descriptions.${lang}.json: ${kept} rows, ${(json.length / 1048576).toFixed(2)} MB`)
}
if (!report.length) {
  console.error('nothing written')
  process.exit(1)
}
