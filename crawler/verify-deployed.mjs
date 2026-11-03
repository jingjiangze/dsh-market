# Verifies what users actually download: the deployed index must be byte-identical
# to the repository copy and must still pass the real format-1 validator.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGES = 'https://jingjiangze.github.io/dsh-market/index.json'
const BRAND = 'https://dsh.jiangjiangze.icu/index.json'
const { parseMarketIndex } = await import('@deepseek-ai/dsh-plugin-market-index')

const sha = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16)
const failures = []

const local = await readFile(join(root, 'site', 'index.json'))
console.log(`local  ${sha(local)}  ${local.length} B`)

let pagesBytes = null
for (const [label, url, required] of [['github-pages', PAGES, true], ['brand-domain', BRAND, false]]) {
  let body = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000), cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      body = Buffer.from(await res.arrayBuffer())
      break
    } catch (err) {
      if (attempt === 3) {
        const message = `${label} unreachable: ${err.message}`
        if (required) failures.push(message)
        else console.log(`warn   ${message} (not fatal)`)
      } else {
        await new Promise((r) => setTimeout(r, 3000 * attempt))
      }
    }
  }
  if (!body) continue
  console.log(`${label.padEnd(13)} ${sha(body)}  ${body.length} B`)
  if (label === 'github-pages') pagesBytes = body
  try {
    const parsed = parseMarketIndex(JSON.parse(body.toString('utf8')), url)
    console.log(`${label.padEnd(13)} format 1 ok, ${parsed.plugins.length} plugins`)
  } catch (err) {
    failures.push(`${label} fails the real validator: ${err.message}`)
  }
}

if (pagesBytes && sha(pagesBytes) !== sha(local)) {
  failures.push('deployed index differs from the repository copy — redeploy needed')
}

if (failures.length) {
  for (const failure of failures) console.log(`FAIL   ${failure}`)
  process.exit(1)
}
console.log('\nSYNC OK')
