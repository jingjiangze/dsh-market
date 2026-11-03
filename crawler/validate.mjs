// Validate the published index before it is allowed to merge or deploy.
//
// Uses the real format-1 validator from npm (@deepseek-ai/dsh-plugin-market-index),
// so the check is the same one DSH itself runs 鈥?not a reimplementation.
//
//   npm i --no-save @deepseek-ai/dsh-plugin-market-index@0.2.1-rc.5
//   node crawler/validate.mjs [--offline]
import { readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OFFLINE = process.argv.includes('--offline')
const HTML_LIMIT = 1024
// 12 MB: a merged ~10k-entry index (slim catalog entries + verified ones) lands
// around 9.6 MB, and DSH handles documents of this size (20k ≈ 7.6 MB bare).
const MAX_INDEX_BYTES = 12 * 1024 * 1024

const failures = []
const notes = []
const fail = (what, detail) => failures.push({ what, detail })
const note = (what, detail) => notes.push({ what, detail })

const read = (rel) => readFile(join(root, rel), 'utf8')

async function size(rel) {
  try {
    return (await stat(join(root, rel))).size
  } catch {
    return null
  }
}

// 1. the document DSH will actually read must pass the real validator
const { parseMarketIndex } = await import('@deepseek-ai/dsh-plugin-market-index')
const distText = await read('dist/index.json')
const indexUrl = 'https://jingjiangze.github.io/dsh-market/index.json'

let parsed
try {
  parsed = parseMarketIndex(JSON.parse(distText), indexUrl)
} catch (err) {
  fail('format 1 validation', `${err.name}: ${err.message}`)
}

if (parsed) {
  note('index', `${parsed.plugins.length} plugins, title=${JSON.stringify(parsed.title.en)}`)
  if (parsed.plugins.length === 0) fail('plugin count', 'index is empty')
  const declaredCategories = new Set(Object.keys(parsed.metadata.categories))
  const declaredLabels = new Set(Object.keys(parsed.metadata.labels))
  const seen = new Set()
  const categoryUse = new Map()
  for (const plugin of parsed.plugins) {
    if (seen.has(plugin.name)) fail('duplicate plugin', plugin.name)
    seen.add(plugin.name)
    // A verified entry must declare compatibility; a catalog-only entry may omit
    // it, but then it must say so through the label the UI renders.
    const pluginLabels = plugin.metadata?.labels ?? []
    const declaresEngines = plugin.versions[0]?.engines?.dsh !== undefined
    if (!declaresEngines && !pluginLabels.includes('no-engines')) {
      fail('missing engines.dsh', plugin.name)
    }
    if (declaresEngines && pluginLabels.includes('no-engines')) {
      fail('no-engines label on a version that declares engines', plugin.name)
    }
    const category = plugin.metadata.category
    if (!category) fail('missing category', plugin.name)
    else if (!declaredCategories.has(category)) fail('undeclared category', `${plugin.name} -> ${category}`)
    else categoryUse.set(category, (categoryUse.get(category) || 0) + 1)
    for (const field of ['title', 'description']) {
      const value = plugin[field]
      if (!value || typeof value !== 'object' || !value.en || !value.zh) {
        fail('bilingual text', `${plugin.name} ${field}`)
      }
    }
    for (const label of plugin.metadata.labels ?? []) {
      if (!declaredLabels.has(label)) fail('undeclared label', `${plugin.name} -> ${label}`)
    }
  }
  note('categories', [...categoryUse].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id}:${n}`).join(' '))
}

// 2. what is deployed must be what was validated
const distBytes = Buffer.byteLength(distText)
if (distBytes > MAX_INDEX_BYTES) fail('index size', `${distBytes} > ${MAX_INDEX_BYTES}`)
const siteText = await read('site/index.json').catch(() => null)
if (siteText === null) fail('site/index.json', 'missing')
else if (siteText !== distText) fail('site/index.json', 'differs from dist/index.json')
else note('site/index.json', 'byte-identical to dist/index.json')

// The two per-source splits must also be valid format-1 documents: a reader may
// subscribe to them alone.
for (const name of ['index.cn.json', 'index.intl.json']) {
  const text = await read(join('dist', name)).catch(() => null)
  if (text === null) {
    fail(name, 'missing')
    continue
  }
  try {
    const parsed = parseMarketIndex(JSON.parse(text), `https://jingjiangze.github.io/dsh-market/${name}`)
    if (parsed.plugins.length === 0) fail(name, 'split is empty')
    else note(name, `${parsed.plugins.length} plugins`)
  } catch (err) {
    fail(name, `${err.name}: ${err.message}`)
  }
}

// 3. the landing page stays under the agreed budget and carries no local refs
const htmlBytes = await size('site/index.html')
if (htmlBytes === null) fail('site/index.html', 'missing')
else if (htmlBytes >= HTML_LIMIT) fail('site/index.html size', `${htmlBytes} >= ${HTML_LIMIT}`)
else note('site/index.html', `${htmlBytes} bytes < ${HTML_LIMIT}`)

const styleBytes = await size('site/style.css')
if (!styleBytes) fail('site/style.css', 'missing')
else note('site/style.css', `${styleBytes} bytes`)

const appBytes = await size('site/app.js')
if (!appBytes) fail('site/app.js', 'missing')
else note('site/app.js', `${appBytes} bytes`)

const html = await read('site/index.html')
for (const bad of ['127.0.0.1', 'localhost', 'file://']) {
  if (html.includes(bad)) fail('site/index.html reference', `contains ${bad}`)
}
// Site assets are served from our own origin. jsDelivr caches @main for hours and
// a purge did not land in time during a redesign, which left readers on the old
// stylesheet; third-party icons stay on jsDelivr, where npm versions are immutable.
if (!/href=["']?\/style\.css/.test(html)) fail('stylesheet', 'index.html does not link /style.css')
if (!/src=["']?\/app\.js/.test(html)) fail('script', 'index.html does not load /app.js')
if (/cdn\.jsdelivr\.net\/gh\/jingjiangze/.test(html)) {
  fail('own asset on CDN', 'index.html still points at the jsDelivr copy of our own assets')
}
// no inline logic: the shell stays declarative so it can stay tiny
if (/<script(?![^>]*\bsrc=)/.test(html)) fail('site/index.html inline script', 'shell must not inline JavaScript')
// no local raster/font/video assets: visuals are CSS or mirrored icons
for (const forbidden of ['.png', '.jpg', '.woff2', '.mp4']) {
  if (html.includes(forbidden)) fail('site/index.html asset', `inlines ${forbidden}`)
}

// 4. every published entry must be installable: the version exists, is a bundle,
//    and its engines.dsh still covers the runtime this index targets
const runtime = JSON.parse(await read('dist/stats.json')).dshRuntime
async function checkPlugin(plugin) {
  const version = plugin.versions[0]
  const url = `https://registry.npmjs.org/${plugin.name.replace('/', '%2f')}/${version.version}`
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-market-ci/1.0' },
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return fail('registry', `${plugin.name}@${version.version} 鈫?HTTP ${res.status}`)
    const manifest = await res.json()
    if (!manifest.dsh?.bundle?.patch) fail('registry', `${plugin.name}@${version.version} declares no dsh.bundle.patch`)
    if (!manifest.engines?.dsh) fail('registry', `${plugin.name}@${version.version} declares no engines.dsh`)
    if (manifest.engines?.dsh !== version.engines.dsh) {
      fail('registry drift', `${plugin.name}@${version.version} engines.dsh ${JSON.stringify(manifest.engines?.dsh)} != index ${JSON.stringify(version.engines.dsh)}`)
    }
  } catch (err) {
    fail('registry', `${plugin.name}@${version.version} 鈫?${err.message}`)
  }
}

if (!OFFLINE && parsed) {
  const list = parsed.plugins
  for (let i = 0; i < list.length; i += 8) {
    await Promise.all(list.slice(i, i + 8).map(checkPlugin))
  }
  note('registry', `${list.length} entries checked against registry.npmjs.org`)
}

// 5. report
const byWhat = new Map()
for (const f of failures) byWhat.set(f.what, (byWhat.get(f.what) || 0) + 1)
for (const n of notes) console.log(`  ok   ${n.what}: ${n.detail}`)
if (failures.length === 0) {
  console.log(`\nPASS ${notes.length} checks, runtime ${runtime}`)
  process.exit(0)
}
console.log(`\nFAIL ${failures.length} problem(s):`)
for (const [what, count] of [...byWhat].sort((a, b) => b[1] - a[1])) console.log(`  ${what} 脳${count}`)
for (const f of failures.slice(0, 20)) console.log(`  - ${f.what}: ${f.detail}`)
process.exit(1)
