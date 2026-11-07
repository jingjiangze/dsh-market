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
import { applyTranslations } from './i18n.mjs'
import { assertKnownCategories } from './category-gate.mjs'
import { existsSync } from 'node:fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const LANGS = ['zh', 'en', 'ja', 'ko', 'ru']
// Which language documents are committed for GitHub Pages (the rest stay on the
// ModelScope dataset). Override with SITE_LANGS=zh,en when another language has to
// become a DSH subscription link too.
const SITE_LANGS = new Set((process.env.SITE_LANGS || 'zh').split(',').map((v) => v.trim()))
const pick = (value, lang) => (typeof value === 'string' ? value : (value?.[lang] ?? ''))

// Installs from the Chinese document go through the npm mirror: the schema allows a
// per-version `source.registry`, and npmjs is slow to reach from mainland China
// (the same reason we serve the page itself from a China-friendly path).
const CN_REGISTRY = process.env.CN_REGISTRY || 'https://registry.npmmirror.com'
const CN_LANGS = new Set((process.env.CN_REGISTRY_LANGS || 'zh').split(',').map((v) => v.trim()))

// Rewrite the version source: keep `type`, add the mirror when this language is a
// China-facing document, and drop any registry the crawler already set.
function sourceFor(version, lang) {
  const base = { type: version?.source?.type ?? 'npm' }
  if (base.type !== 'npm') return version?.source ?? base
  const registry = CN_LANGS.has(lang) ? CN_REGISTRY : version?.source?.registry
  return registry ? { ...base, registry } : base
}

const index = JSON.parse(await readFile(join(root, 'dist', 'index.json'), 'utf8'))
// Registry probe results (crawler/probe-npm.mjs). Absent cache = everything is treated as
// unknown and published, so a fresh checkout without the cache still works.
const PROBE = join(root, 'data', 'npm-probe.json')
const probe = existsSync(PROBE) ? JSON.parse(await readFile(PROBE, 'utf8')) : {}
const INSTALLABLE = (plugin) => {
  const version = plugin.versions?.[0] ?? {}
  const source = version.source ?? {}
  if (source.type === 'git') return /^[0-9a-f]{40}$/i.test(String(source.commit ?? ''))
  const result = probe[plugin.name]
  if (!result) return true // never probed: keep it, the site shows the caveat
  return result.npmmirror === 'ok' || result.npmjs === 'ok'
}
const plugins = index.plugins ?? []
// This file copies `metadata.category` out of dist/index.json and never re-derives it
// (crawl.mjs owns that). So a stale dist republishes categories the taxonomy has since
// replaced — which is exactly what shipped on 2026-11-07: 14 ids (work / data /
// connect / …) that no leaf in taxonomy.mjs could render, published with every check
// green. Fail the build instead.
assertKnownCategories(plugins, 'dist/index.json')
// The translate job writes strings into dist/index.json and the content-hash cache.
// When this step is run standalone (translate.yml) the cache may contain newer
// translations than the document; replay them so no language document loses text.
await applyTranslations(plugins)

function localized(value, lang) {
  const english = pick(value, 'en') || pick(value, 'zh') || ''
  if (lang === 'en') return { en: english }
  const target = pick(value, lang)
  return target && target !== english ? { en: english, [lang]: target } : { en: english }
}

const publishable = plugins.filter(INSTALLABLE)
const withheld = plugins.length - publishable.length
if (withheld) console.log(`lang-index: withheld ${withheld} entries whose registry source does not resolve (${plugins.length} -> ${publishable.length})`)

const report = []
const sizes = []
for (const lang of LANGS) {
  // Two copies of each language document:
  //   dist/index.<lang>.json  full  -> published to the ModelScope dataset (国内源)
  //   site/index.<lang>.json  slim  -> committed to git, served by GitHub Pages (国外源)
  // The slim copy drops icon/homepage/keywords and trims the description: it exists
  // so an overseas reader can subscribe to one language without pulling 12 MB, and
  // so the repository does not grow by ~42 MB on every crawl.
  const full = {
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
      versions: (plugin.versions ?? []).map((version) => ({ ...version, source: sourceFor(version, lang) })),
    })),
  }
  // Sized for the wire, not for humans: see the budget check at the end of this file.
  // 32 characters is still a full Chinese phrase and buys ~0.9 MB back at 15k entries,
  // which matters because the client fetches this document uncompressed.
  const TITLE_MAX = 32
  const DESC_MAX = 32
  const text60 = (value, max) => {
    const raw = String(value ?? '')
    return raw.length > max ? raw.slice(0, max) + '…' : raw
  }
  // Value labels, not build diagnostics: a client renders these as chips, so every id has
  // to mean something to a reader. Each one is backed by a fact this build actually
  // checked — nothing here claims an audit that did not happen.
  // Only facts this build established. There is deliberately no "low risk" label: calling
  // a plugin low-risk is a security verdict, and nothing here audits code. What a client
  // can honestly know from this document is whether the install resolves, whether the
  // source is pinned, and whether the catalogue that curates it vouches for it.
  const CURATION_LABELS = {
    official: { title: { en: 'Official pick', zh: '官方精选' } },
    'install-verified': { title: { en: 'Install verified', zh: '安装已验证' } },
    'source-pinned': { title: { en: 'Pinned source', zh: '源码已固定' } },
    'declares-engines': { title: { en: 'Declares DSH range', zh: '声明兼容版本' } },
  }
  // Curation answers "should I look at this first", trust answers "is it safe to install".
  // Both are 0..100 so a client can sort by them with the existing sortKeys mechanism.
  const CURATION_SORT = {
    curated: { title: { en: 'Curated', zh: '精选度' }, order: 'desc' },
    trust: { title: { en: 'Trust', zh: '可信度' }, order: 'desc' },
  }

  const slimPlugin = (plugin) => {
    const version = plugin.versions?.[0] ?? {}
    const english = pick(plugin.description, 'en')
    const target = lang === 'en' ? '' : pick(plugin.description, lang)
    // Only carry the English fallback when the reader's language is missing; keeping
    // both for every entry cost ~1.8 MB on its own.
    // No heat gate. It looked harmless, but the score lives in metadata.sortKeys, which the
    // batch steps (pin/restore-alias) rewrite: when it was absent every description was
    // dropped and the published document became metadata-only (0 of 10,559 rows carried one).
    // A gate that silently empties the field is worse than a slightly larger document.
    const meaningful = Boolean(english) && english.trim().toLowerCase() !== String(plugin.name).toLowerCase()
    const description = !meaningful
      ? null
      : target && target !== english
        ? { en: text60(english, DESC_MAX), [lang]: text60(target, DESC_MAX) }
        : { en: text60(english, DESC_MAX) }
    return {
      name: plugin.name,
      ...(() => {
        const english = text60(pick(plugin.title, 'en'), TITLE_MAX)
        const local = lang === 'en' ? '' : text60(pick(plugin.title, lang), TITLE_MAX)
        // `title` is optional in format 1 and DSH already renders the package name,
        // so repeating it for 60% of the catalogue only costs bytes.
        if ((!local || local === english) && english.toLowerCase() === String(plugin.name).toLowerCase()) return {}
        return { title: { en: english, ...(local && local !== english ? { [lang]: local } : {}) } }
      })(),
      ...(description ? { description } : {}),
      metadata: (() => {
        const labels = new Set(plugin.metadata?.labels ?? [])
        const sortKeys = plugin.metadata?.sortKeys ?? {}
        const stars = Number(sortKeys.stars ?? 0)
        const downloads = Number(sortKeys.downloads ?? 0)
        const engines = Boolean(version.engines?.dsh)
        // The probe is the measurement; the label is only what a catalogue claimed.
        const probed = probe[plugin.name]
        const verified = Boolean(probed) && (probed.npmmirror === 'ok' || probed.npmjs === 'ok')
        const pinned = version.source?.type === 'git' && /^[0-9a-f]{40}$/i.test(String(version.source.commit ?? ''))
        const official = labels.has('src-official')
        const sources = [...labels].filter((l) => String(l).startsWith('src-')).length
        const heat = Math.min(100, Math.round((Math.log10(1 + stars) / 3.8) * 55 + (Math.log10(1 + downloads) / 5) * 45))

        // Curation: the official catalogue is itself the hand-picked allow-list (4.7k of
        // 15k), so membership dominates; popularity breaks the ties.
        const curated = Math.max(0, Math.min(100, Math.round(
          (official ? 55 : 0) + heat * 0.25 + (verified ? 20 : 0),
        )))
        // "Trust" here is install confidence — how much of the install path this build was
        // able to verify — not a judgement about the code. A registry hit is stronger than
        // a commit pin only because it also proves the version was published.
        const trust = Math.max(0, Math.min(100,
          40 * (verified ? 1 : 0) + 30 * (pinned ? 1 : 0) + 20 * (engines ? 1 : 0)
          + 10 * Math.min(2, sources),
        ))

        const out = new Set()
        if (official) out.add('official')
        if (verified) out.add('install-verified')
        if (pinned) out.add('source-pinned')
        if (engines) out.add('declares-engines')

        return {
          category: plugin.metadata?.category ?? 'other',
          ...(out.size ? { labels: [...out] } : {}),
          sortKeys: { curated, trust },
        }
      })(),
      versions: [{
        version: version.version ?? '',
        publishTimestamp: version.publishTimestamp ?? 0,
        source: sourceFor(version, lang),
        ...(version.engines ? { engines: version.engines } : {}),
      }],
    }
  }
  const generatedAt = new Date().toISOString()
  // Every label and sort key used above must be declared here, or the format-1 validator
  // rejects the document.
  const slimMetadata = {
    ...(full.metadata ?? {}),
    labels: { ...(full.metadata?.labels ?? {}), ...CURATION_LABELS },
    sortKeys: { ...(full.metadata?.sortKeys ?? {}), ...CURATION_SORT },
  }
  const slim = {
    ...full,
    // Self-reported build time: the client caches this document on disk and needs
    // something to expire against.
    metadata: { ...slimMetadata, generatedAt },
    plugins: publishable.map(slimPlugin),
  }
  // Dataset copy: compact, and projected exactly like the Pages copy. Indentation
  // alone used to cost ~35% of the payload and nothing reads these files by eye.
  const text = JSON.stringify({ ...full, plugins: publishable.map(slimPlugin) }) + '\n'
  const slimText = JSON.stringify(slim) + '\n'
  await writeFile(join(root, 'dist', `index.${lang}.json`), text)
  // Only the Chinese document is committed for GitHub Pages: DSH subscribes to it
  // and Pages serves from git, so it has to be tracked. The other four live on the
  // ModelScope dataset only — tracking them cost ~18 MB in every crawl commit and
  // nothing read them (the site itself renders from the browse chunks).
  if (SITE_LANGS.has(lang)) await writeFile(join(root, 'site', `index.${lang}.json`), slimText)
  sizes.push(Buffer.byteLength(slimText))
  const translated = publishable.filter((plugin) => Object.keys(plugin.title ?? {}).length > 1).length
  report.push(`${lang}: full ${(Buffer.byteLength(text) / 1048576).toFixed(2)} MB, slim ${(Buffer.byteLength(slimText) / 1048576).toFixed(2)} MB${SITE_LANGS.has(lang) ? ' (tracked)' : ''}, ${translated}/${publishable.length} localized`)
}
console.log(`lang-index: ${plugins.length} plugins -> ${LANGS.length} documents`)
for (const line of report) console.log(`  ${line}`)

// Budget gate. DSH fetches this document without compression and gives the market
// request 30 s; at the local link speed an 8.2 MB body took 26 s and timed out
// intermittently. Anything above BUDGET_MB is a regression that breaks installation
// for readers on a slower path, so fail the build instead of publishing it.
const BUDGET_MB = Number(process.env.LANG_INDEX_BUDGET_MB || 8)
const biggest = Math.max(...sizes, 0) / 1048576
if (biggest > BUDGET_MB) {
  console.error(`lang-index: FAIL — largest language document is ${biggest.toFixed(2)} MB, budget ${BUDGET_MB} MB`)
  process.exit(1)
}
console.log(`lang-index: largest document ${biggest.toFixed(2)} MB (budget ${BUDGET_MB} MB)`)
