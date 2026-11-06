// Rehydrate translations into an index that was rebuilt from scratch.
//
// The crawl rebuilds dist/index.json from the shard parts every run, which used to
// discard every string the hourly translate job had just produced — coverage never
// rose above ~5%. The translations themselves live in data/i18n-cache.json, keyed by
// `lang:sha1(sourceText)[:16]`; this module replays them onto the freshly assembled
// plugins so a rebuild can never lose translated text again.
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(root, 'data', 'i18n-cache.json')
const LANGS = ['zh', 'ja', 'ko', 'ru']
// Must match crawler/translate.mjs exactly: the cache key is computed from the
// truncated source text, so a different MAX_TEXT would make every lookup miss.
export const MAX_TEXT = 420

export async function applyTranslations(plugins, log = console.log) {
  let cache = {}
  try { cache = JSON.parse(await readFile(CACHE, 'utf8')) } catch { return 0 }
  const keyOf = (lang, text) => `${lang}:${createHash('sha1').update(String(text)).digest('hex').slice(0, 16)}`
  let filled = 0
  for (const plugin of plugins ?? []) {
    for (const field of ['title', 'description']) {
      const value = plugin?.[field]
      if (!value || typeof value !== 'object') continue
      const source = String(value.en ?? value.zh ?? '').slice(0, MAX_TEXT)
      if (!source) continue
      for (const lang of LANGS) {
        if (value[lang]) continue
        const hit = cache[keyOf(lang, source)]
        if (hit && typeof hit === 'string') { value[lang] = hit; filled++ }
      }
    }
  }
  if (filled) log(`i18n rehydrate: +${filled} translated fields from cache`)
  return filled
}
