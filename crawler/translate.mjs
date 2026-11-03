// Adds more languages to the index with Google Translate, through the public
// gtx endpoint the translate.google.com page itself uses. Everything is cached
// by content hash, so a description is translated once and never again; a failed
// call leaves the field out rather than publishing a broken string.
//
//   node crawler/translate.mjs            # translate what is missing
//   node crawler/translate.mjs --offline  # report only
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGETS = (process.env.TRANSLATE_LANGS || 'ja,ko,ru').split(',').map((s) => s.trim()).filter(Boolean)
const OFFLINE = process.argv.includes('--offline')
const CONCURRENCY = Number(process.env.TRANSLATE_CONCURRENCY || 4)
const MAX_TEXT = 420
const hasCjk = (value) => /[\u4e00-\u9fff]/.test(String(value ?? ''))

const cachePath = join(root, 'data', 'i18n-cache.json')
let cache = {}
try {
  cache = JSON.parse(await readFile(cachePath, 'utf8'))
} catch {
  cache = {}
}
const keyOf = (lang, text) => `${lang}:${createHash('sha1').update(String(text)).digest('hex').slice(0, 16)}`

async function translate(text, lang) {
  const key = keyOf(lang, text)
  if (cache[key]) return cache[key]
  if (OFFLINE) return null
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(text)}`
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 dsh-market' }, signal: AbortSignal.timeout(15000) })
    if (!res.ok) return null
    const body = await res.json()
    const out = (body?.[0] ?? []).map((part) => part?.[0] ?? '').join('').trim()
    if (!out) return null
    cache[key] = out
    return out
  } catch {
    return null
  }
}

const index = JSON.parse(await readFile(join(root, 'dist', 'index.json'), 'utf8'))
const text = (value) => (typeof value === 'string' ? value : (value?.zh || value?.en || ''))
let translated = 0
let skipped = 0

for (const plugin of index.plugins ?? []) {
  for (const field of ['title', 'description']) {
    const value = plugin[field]
    if (!value || typeof value !== 'object') continue
    const source = text(value).slice(0, MAX_TEXT)
    if (!source) continue
    for (const lang of TARGETS) {
      if (value[lang]) continue
      const out = await translate(source, lang)
      if (out) {
        value[lang] = out
        translated++
      } else {
        skipped++
      }
    }
  }
}

const langs = new Set()
for (const plugin of index.plugins ?? []) {
  for (const field of ['title', 'description']) {
    for (const lang of Object.keys(plugin[field] ?? {})) langs.add(lang)
  }
}

if (!OFFLINE) {
  await writeFile(join(root, 'dist', 'index.json'), JSON.stringify(index, null, 2) + '\n')
  await writeFile(cachePath, JSON.stringify(cache) + '\n')
}
console.log(`translate: ${translated} strings added, ${skipped} skipped, languages now [${[...langs].sort().join(', ')}]`)
