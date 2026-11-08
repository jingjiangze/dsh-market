// Adds more languages to the index with Google Translate, through the public gtx
// endpoint the translate.google.com page itself uses. Everything is cached by
// content hash, so a description is translated once and never again; a failed
// call leaves the field out rather than publishing a broken string.
//
// The pass is bounded (time and string count) because a first run has ~1000
// strings to fill and GitHub runners get throttled: a bounded pass fills the
// cache over a few runs instead of turning one crawl into an hour.
//
//   node crawler/translate.mjs            # translate what is missing
//   node crawler/translate.mjs --offline  # report only
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MAX_TEXT } from './i18n.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TARGETS = (process.env.TRANSLATE_LANGS || 'zh,ja,ko,ru').split(',').map((s) => s.trim()).filter(Boolean)
// Titles are never translated into Chinese: most titles are the package name, and turning
// "dsh-ops" into Chinese produces a name no search or install path can use. The crawl
// derives a Chinese title from the Chinese description instead (see zhTitle in crawl.mjs).
const TITLE_SKIP_LANGS = new Set(['zh'])
const CJK = /[\u4e00-\u9fff]/
const OFFLINE = process.argv.includes('--offline')
const CONCURRENCY = Number(process.env.TRANSLATE_CONCURRENCY || 12)
const BUDGET_MS = Number(process.env.TRANSLATE_BUDGET_MS || 6 * 60 * 1000)
const MAX_STRINGS = Number(process.env.TRANSLATE_MAX_STRINGS || 400)
const CALL_TIMEOUT_MS = 6000

const cachePath = join(root, 'data', 'i18n-cache.json')
let cache = {}
try {
  cache = JSON.parse(await readFile(cachePath, 'utf8'))
} catch {
  cache = {}
}

const keyOf = (lang, text) => `${lang}:${createHash('sha1').update(String(text)).digest('hex').slice(0, 16)}`
let attempted = 0
let translated = 0
let failed = 0

async function translate(text, lang) {
  const key = keyOf(lang, text)
  if (cache[key]) return cache[key]
  if (OFFLINE) return null
  attempted++
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${lang}&dt=t&q=${encodeURIComponent(text)}`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 dsh-market' }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) })
      if (res.status === 429 || res.status >= 500) {
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
        continue
      }
      if (!res.ok) {
        failed++
        return null
      }
      const body = await res.json()
      const out = (body?.[0] ?? []).map((part) => part?.[0] ?? '').join('').trim()
      if (!out) {
        failed++
        return null
      }
      cache[key] = out
      translated++
      return out
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)))
    }
  }
  failed++
  return null
}

const started = Date.now()
const index = JSON.parse(await readFile(join(root, 'dist', 'index.json'), 'utf8'))
const text = (value) => (typeof value === 'string' ? value : (value?.zh || value?.en || ''))
const stop = () => OFFLINE || Date.now() - started > BUDGET_MS || attempted >= MAX_STRINGS

// One queue, a fixed worker pool: the previous version awaited each call inside
// the loop, so "concurrency" was never actually used.
const tasks = []
// Language-major: finish zh before starting ja. With ~18k strings per language and a 45-minute
// budget, a plugin-major queue would leave every language a fifth done instead of one done.
for (const lang of TARGETS) {
  for (const plugin of index.plugins ?? []) {
    for (const field of ['title', 'description']) {
      const value = plugin[field]
      if (!value || typeof value !== 'object') continue
      const source = text(value).slice(0, MAX_TEXT)
      if (!source) continue
      // A value identical to the source is not a translation. The crawler used to pre-fill
      // zh with the English text, which made this loop skip exactly the entries that needed
      // work — fixing it in crawl.mjs only helps future builds, so treat the existing
      // copies as missing too.
      if (value[lang] && value[lang] !== source) continue
      if (field === 'title' && TITLE_SKIP_LANGS.has(lang)) continue
      // Some catalogues park a Chinese blurb under `en`; translating that "to Chinese"
      // would launder a correct string through a translator for no reason.
      if (lang === 'zh' && CJK.test(source)) continue
      tasks.push({ value, lang, source })
    }
  }
}

let cursor = 0
async function worker() {
  while (cursor < tasks.length && !stop()) {
    const task = tasks[cursor++]
    const out = await translate(task.source, task.lang)
    if (out) task.value[task.lang] = out
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length || 1) }, worker))

const langs = new Set()
for (const plugin of index.plugins ?? []) {
  for (const field of ['title', 'description']) for (const lang of Object.keys(plugin[field] ?? {})) langs.add(lang)
}

if (!OFFLINE) {
  await writeFile(join(root, 'dist', 'index.json'), JSON.stringify(index) + '\n')
  await writeFile(cachePath, JSON.stringify(cache) + '\n')
}
const left = tasks.length - cursor
console.log(`translate: ${translated} added, ${failed} failed, ${left} left for later (${tasks.length} needed)`)
console.log(`languages now [${[...langs].sort().join(', ')}]`)
