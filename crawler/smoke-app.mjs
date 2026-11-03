// Executes the browser bundle against a minimal DOM stub, so CI catches a page
// that would render nothing before it reaches users. No browser, no dependency.
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const index = JSON.parse(await readFile(join(root, 'site', 'index.json'), 'utf8'))
const stats = JSON.parse(await readFile(join(root, 'dist', 'stats.json'), 'utf8'))
const source = await readFile(join(root, 'site', 'app.js'), 'utf8')

const elements = new Map()
function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      id, textContent: '', innerHTML: '', value: '', dataset: {}, focused: false,
      addEventListener() {}, focus() { this.focused = true },
    })
  }
  return elements.get(id)
}

const document = {
  activeElement: null,
  getElementById: (id) => element(id),
  addEventListener() {},
}
const localStorage = { getItem: () => null, setItem() {} }
const navigator = { language: 'zh-CN', clipboard: { writeText: async () => {} } }
const fetchStub = async (url) => {
  if (String(url).includes('stats.json')) return { ok: true, json: async () => stats }
  return { ok: true, json: async () => index }
}
const setTimeoutStub = (fn) => 0

const run = new Function('document', 'localStorage', 'navigator', 'fetch', 'setTimeout', 'console', source)
run(document, localStorage, navigator, fetchStub, setTimeoutStub, console)

// main() is async: give its microtasks a turn, then inspect what a reader sees.
await new Promise((resolve) => setTimeoutReal(resolve, 50))

const list = element('list').innerHTML
const meta = element('meta').textContent
const cats = element('cats').innerHTML
const cards = (list.match(/class=card/g) ?? []).length

const problems = []
if (!meta.includes(String(index.plugins.length))) problems.push(`header does not show the plugin count: ${JSON.stringify(meta)}`)
if (cards === 0) problems.push('no plugin card rendered')
if (cards > 120) problems.push(`rendered ${cards} cards — pagination is not limiting the DOM`)
if (!list.includes('dsh-') && !list.includes('@')) problems.push('cards carry no package names')
const more = list.includes('data-more')
if (index.plugins.length > cards && !more) problems.push('catalog is larger than one page but no "show more" control exists')
if (index.plugins.length <= cards && more) problems.push('"show more" rendered for a catalog that fits one page')

if (problems.length) {
  for (const problem of problems) console.log(`FAIL  ${problem}`)
  process.exit(1)
}
console.log(`PASS  ${cards}/${index.plugins.length} cards, ${(cats.match(/data-cat=/g) ?? []).length} chips, header ${JSON.stringify(meta)}`)

function setTimeoutReal(fn, ms) {
  return setTimeout(fn, ms)
}
