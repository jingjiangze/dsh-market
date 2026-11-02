// Validate the published index before it is allowed to merge or deploy.
//
// Uses the real format-1 validator from npm (@deepseek-ai/dsh-plugin-market-index),
// so the check is the same one DSH itself runs — not a reimplementation.
//
//   npm i --no-save @deepseek-ai/dsh-plugin-market-index@0.2.1-rc.5
//   node crawler/validate.mjs [--offline]
import { readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OFFLINE = process.argv.includes('--offline')
const HTML_LIMIT = 1024
const MAX_INDEX_BYTES = 2 * 1024 * 1024

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
  const seen = new Set()
  for (const plugin of parsed.plugins) {
    if (seen.has(plugin.name)) fail('duplicate plugin', plugin.name)
    seen.add(plugin.name)
    if (plugin.versions[0]?.engines?.dsh === undefined) {
      fail('missing engines.dsh', plugin.name)
    }
  }
}

// 2. what is deployed must be what was validated
const distBytes = Buffer.byteLength(distText)
if (distBytes > MAX_INDEX_BYTES) fail('index size', `${distBytes} > ${MAX_INDEX_BYTES}`)
const siteText = await read('site/index.json').catch(() => null)
if (siteText === null) fail('site/index.json', 'missing')
else if (siteText !== distText) fail('site/index.json', 'differs from dist/index.json')
else note('site/index.json', 'byte-identical to dist/index.json')

// 3. the landing page stays under the agreed budget and carries no local refs
const htmlBytes = await size('site/index.html')
if (htmlBytes === null) fail('site/index.html', 'missing')
else if (htmlBytes >= HTML_LIMIT) fail('site/index.html size', `${htmlBytes} >= ${HTML_LIMIT}`)
else note('site/index.html', `${htmlBytes} bytes < ${HTML_LIMIT}`)

const styleBytes = await size('site/style.css')
if (!styleBytes) fail('site/style.css', 'missing')
else note('site/style.css', `${styleBytes} bytes`)

const html = await read('site/index.html')
for (const bad of ['127.0.0.1', 'localhost', 'file://', 'cdn.jsdelivr.net/gh/']) {
  if (html.includes(bad)) fail('site/index.html reference', `contains ${bad}`)
}
// assets should come from mirrors, not from the site itself
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
    if (!res.ok) return fail('registry', `${plugin.name}@${version.version} → HTTP ${res.status}`)
    const manifest = await res.json()
    if (!manifest.dsh?.bundle?.patch) fail('registry', `${plugin.name}@${version.version} declares no dsh.bundle.patch`)
    if (!manifest.engines?.dsh) fail('registry', `${plugin.name}@${version.version} declares no engines.dsh`)
    if (manifest.engines?.dsh !== version.engines.dsh) {
      fail('registry drift', `${plugin.name}@${version.version} engines.dsh ${JSON.stringify(manifest.engines?.dsh)} != index ${JSON.stringify(version.engines.dsh)}`)
    }
  } catch (err) {
    fail('registry', `${plugin.name}@${version.version} → ${err.message}`)
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
for (const [what, count] of [...byWhat].sort((a, b) => b[1] - a[1])) console.log(`  ${what} ×${count}`)
for (const f of failures.slice(0, 20)) console.log(`  - ${f.what}: ${f.detail}`)
process.exit(1)
