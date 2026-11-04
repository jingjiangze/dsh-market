// Builds a compact index for DSH index sources that are slow to download.
//
// Measurements that led here: the full slim document is 4.6 MB and takes 40-88 s
// from China on GitHub Pages, ModelScope answers 302 (DSH rejects redirects), and
// Cloudflare Pages throttles to ~4 KB/s there. A small file downloads in seconds,
// so this emits the top N packages by stars with only the fields DSH needs.
//
//   node crawler/lite-index.mjs                 # top 2000 -> site/index.zh.lite.json
//   LITE_TOP=3000 LITE_LANG=zh node crawler/lite-index.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOP = Number(process.env.LITE_TOP || 2000)
const LANG = process.env.LITE_LANG || 'zh'
const DESC = Number(process.env.LITE_DESC || 90)
const OUT = join(root, 'site', `index.${LANG}.lite.json`)

const pick = (value, lang) => (typeof value === 'string' ? value : (value?.[lang] ?? ''))
const text = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

const index = JSON.parse(await readFile(join(root, 'dist', 'index.json'), 'utf8'))
const plugins = index.plugins ?? []

// Format 1 requires an English fallback in every localized text, so each entry
// keeps `en` plus the target language when it exists.
const localized = (value) => {
  const en = text(pick(value, 'en') || pick(value, 'zh')).slice(0, DESC)
  const target = text(pick(value, LANG))
  return LANG === 'en' || !target || target === en ? { en } : { en, [LANG]: target.slice(0, DESC) }
}

const ranked = [...plugins].sort((a, b) => (b.metadata?.sortKeys?.stars ?? 0) - (a.metadata?.sortKeys?.stars ?? 0)).slice(0, TOP)

const doc = {
  format: 1,
  title: { en: `DSH Plugin Index (lite, top ${ranked.length})`, ...(LANG === 'en' ? {} : { [LANG]: `DSH 插件索引（精简版，按星标前 ${ranked.length}）` }) },
  description: {
    en: 'Compact subset of the DSH plugin index, ordered by stars, for slow networks. The full catalogue is at index.json.',
    ...(LANG === 'en' ? {} : { [LANG]: '按星标排序的插件索引精简版，供网络较慢时使用；完整目录见 index.json。' }),
  },
  metadata: {
    categories: index.metadata?.categories ?? {},
    labels: index.metadata?.labels ?? {},
    sortKeys: index.metadata?.sortKeys ?? {},
  },
  plugins: ranked.map((plugin) => {
    const version = plugin.versions?.[0] ?? {}
    return {
      name: plugin.name,
      title: localized(plugin.title),
      description: localized(plugin.description),
      metadata: {
        category: plugin.metadata?.category ?? 'other',
        ...(plugin.metadata?.labels?.length ? { labels: plugin.metadata.labels.slice(0, 2) } : {}),
        ...(plugin.metadata?.sortKeys ? { sortKeys: plugin.metadata.sortKeys } : {}),
      },
      versions: [{
        version: version.version ?? '',
        publishTimestamp: version.publishTimestamp ?? 0,
        source: version.source ?? { type: 'npm' },
        ...(version.engines ? { engines: version.engines } : {}),
      }],
    }
  }),
}

const text_ = JSON.stringify(doc, null, 2) + '\n'
await writeFile(OUT, text_)
console.log(`lite-index: ${doc.plugins.length}/${plugins.length} plugins -> site/index.${LANG}.lite.json (${(Buffer.byteLength(text_) / 1024).toFixed(0)} KB)`)
