// Splits the catalogue into N small documents for slow networks.
//
// Why: a 4.6 MB index takes 40-88 s from China on GitHub Pages and the brand domain
// is throttled to ~9 KB/s there, while a ~650 KB file downloads in ~2 s. Publishing
// the same catalogue as several ~600 KB parts lets DSH register them as separate
// index sources and fetch them in parallel — no relay, no Worker.
//
//   LITE_SHARDS=6 node crawler/shard-index.mjs      # site/index.zh.p0.json .. p5
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHARDS = Math.max(1, Number(process.env.LITE_SHARDS || 6))
const LANG = process.env.LITE_LANG || 'zh'
const DESC = Number(process.env.LITE_DESC || 70)

const pick = (value, lang) => (typeof value === 'string' ? value : (value?.[lang] ?? ''))
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

const index = JSON.parse(await readFile(join(root, 'dist', 'index.json'), 'utf8'))
const plugins = index.plugins ?? []

const localized = (value) => {
  const en = clean(pick(value, 'en') || pick(value, 'zh')).slice(0, DESC)
  const target = clean(pick(value, LANG))
  return LANG === 'en' || !target || target === en ? { en } : { en, [LANG]: target.slice(0, DESC) }
}

const entryOf = (plugin) => {
  const version = plugin.versions?.[0] ?? {}
  return {
    name: plugin.name,
    title: localized(plugin.title),
    description: localized(plugin.description),
    metadata: {
      category: plugin.metadata?.category ?? 'other',
      ...(plugin.metadata?.sortKeys ? { sortKeys: plugin.metadata.sortKeys } : {}),
    },
    versions: [{
      version: version.version ?? '',
      publishTimestamp: version.publishTimestamp ?? 0,
      source: version.source ?? { type: 'npm' },
      ...(version.engines ? { engines: version.engines } : {}),
    }],
  }
}

const ranked = [...plugins].sort((a, b) => (b.metadata?.sortKeys?.stars ?? 0) - (a.metadata?.sortKeys?.stars ?? 0))
const per = Math.ceil(ranked.length / SHARDS)
let total = 0

for (let i = 0; i < SHARDS; i++) {
  const slice = ranked.slice(i * per, (i + 1) * per)
  if (!slice.length) continue
  const doc = {
    format: 1,
    title: { en: `DSH Plugin Index · part ${i + 1}/${SHARDS}`, ...(LANG === 'en' ? {} : { [LANG]: `DSH 插件索引 · 第 ${i + 1}/${SHARDS} 片` }) },
    description: {
      en: `Part ${i + 1} of ${SHARDS}, ordered by stars. Add every part as a separate index source to get the full catalogue.`,
      ...(LANG === 'en' ? {} : { [LANG]: `共 ${SHARDS} 片，按星标排序。把每一片都添加为索引源即可得到完整目录。` }),
    },
    metadata: {
      categories: index.metadata?.categories ?? {},
      labels: index.metadata?.labels ?? {},
      sortKeys: index.metadata?.sortKeys ?? {},
    },
    plugins: slice.map(entryOf),
  }
  const body = JSON.stringify(doc)
  await writeFile(join(root, 'site', `index.${LANG}.p${i}.json`), body)
  total += Buffer.byteLength(body)
  console.log(`  p${i}: ${slice.length} plugins, ${(Buffer.byteLength(body) / 1024).toFixed(0)} KB`)
}
console.log(`shard-index: ${ranked.length} plugins in ${SHARDS} parts, ${(total / 1024 / 1024).toFixed(2)} MB total`)
