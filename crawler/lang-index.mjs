// Emits one format-1 index per language, so a reader can subscribe to a catalogue
// that is already in their language: index.zh.json, index.en.json, index.ja.json,
// index.ko.json, index.ru.json.
//
// Format 1 requires every localized text to carry an English fallback, so a
// Japanese document still has `en` next to `ja`; what changes is that the other
// languages are dropped, which is what makes each file ~1/5 the size.
//
//   node crawler/lang-index.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const LANGS = ['zh', 'en', 'ja', 'ko', 'ru']
const pick = (value, lang) => (typeof value === 'string' ? value : (value?.[lang] ?? ''))

const index = JSON.parse(await readFile(join(root, 'dist', 'index.json'), 'utf8'))
const plugins = index.plugins ?? []

function localized(value, lang) {
  const english = pick(value, 'en') || pick(value, 'zh') || ''
  if (lang === 'en') return { en: english }
  const target = pick(value, lang)
  return target && target !== english ? { en: english, [lang]: target } : { en: english }
}

const report = []
for (const lang of LANGS) {
  const doc = {
    format: 1,
    title: {
      en: `DSH Plugin Index (${lang})`,
      ...(lang === 'en' ? {} : { [lang]: `DSH 插件索引（${lang}）` }),
    },
    description: localized(index.description ?? {}, lang),
    metadata: index.metadata,
    plugins: plugins.map((plugin) => ({
      ...plugin,
      title: localized(plugin.title, lang),
      description: localized(plugin.description, lang),
    })),
  }
  const text = JSON.stringify(doc, null, 2) + '\n'
  await writeFile(join(root, 'dist', `index.${lang}.json`), text)
  const translated = doc.plugins.filter((plugin) => Object.keys(plugin.title).length > 1).length
  report.push(`${lang}: ${(Buffer.byteLength(text) / 1048576).toFixed(2)} MB, ${translated}/${plugins.length} localized`)
}
console.log(`lang-index: ${plugins.length} plugins -> ${LANGS.length} documents`)
for (const line of report) console.log(`  ${line}`)
