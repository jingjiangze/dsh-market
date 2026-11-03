// Executes the browser bundle against a minimal DOM stub, so CI catches a page
// that would render nothing (or lose its detail view) before it reaches users.
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
      id, textContent: '', innerHTML: '', value: '', dataset: {}, open: false, focused: false,
      addEventListener() {}, focus() { this.focused = true },
      showModal() { this.open = true }, close() { this.open = false },
    })
  }
  return elements.get(id)
}

const document = {
  activeElement: null,
  getElementById: (id) => element(id),
  querySelectorAll: () => [],
  addEventListener() {},
}
const localStorage = { getItem: () => null, setItem() {} }
const navigator = { language: 'zh-CN', clipboard: { writeText: async () => {} } }
const location = { origin: 'https://example.test', pathname: '/dsh-market/' }
const fetchStub = async (url) => ({ ok: true, json: async () => (String(url).includes('stats.json') ? stats : index) })
const setTimeoutStub = () => 0

const run = new Function('document', 'localStorage', 'navigator', 'location', 'fetch', 'setTimeout', 'console', source)
run(document, localStorage, navigator, location, fetchStub, setTimeoutStub, console)
await new Promise((resolve) => setTimeout(resolve, 80))

const list = element('list').innerHTML
const meta = element('meta').textContent
const cats = element('cats').innerHTML
const src = element('src').textContent
const cards = (list.match(/class=card/g) ?? []).length

const problems = []
if (!meta.includes(String(index.plugins.length))) problems.push(`header does not show the plugin count: ${JSON.stringify(meta)}`)
if (cards === 0) problems.push('no plugin card rendered')
if (cards > 120) problems.push(`rendered ${cards} cards — pagination is not limiting the DOM`)
if (!list.includes('data-open=')) problems.push('cards are not clickable (no data-open)')
if (list.includes('主页')) problems.push('cards still carry the removed home-page button')
if (index.plugins.length > cards && !list.includes('data-more')) problems.push('catalogue is larger than one page but no "show more" control exists')
if (!src.startsWith('https://example.test/dsh-market/')) problems.push(`index source is not absolute: ${JSON.stringify(src)}`)
if ((cats.match(/data-cat=/g) ?? []).length < 2) problems.push('category chips missing')

// The detail view is the whole point of a clickable card: exercise it.
const openCard = (list.match(/data-open="([^"]+)"/) ?? [])[1]
if (!openCard) problems.push('cannot find a package to open')
else {
  run.detail ??= null
  const dialog = element('dlg')
  const clickHandler = source.includes('openDetail') ? true : false
  if (!clickHandler) problems.push('detail view is not implemented')
  // Re-run the module's own open path through the exported HTML builder.
  const builder = new Function('document', 'localStorage', 'navigator', 'location', 'fetch', 'setTimeout', 'console',
    `${source}\nreturn { openDetail, dialogHtml, state, render }`)
  const api = builder(document, localStorage, navigator, location, fetchStub, setTimeoutStub, console)
  api.state.data = index
  api.render()
  api.openDetail(openCard)
  if (!dialog.open) problems.push('clicking a card did not open the dialog')
  // The detail drawer shows one language (the switcher's), not two columns.
  if (!/class=lead/.test(dialog.innerHTML)) problems.push('dialog has no description')
  if (/class=dual/.test(dialog.innerHTML)) problems.push('dialog is still the old bilingual two-column layout')
  if (!/data-copy=/.test(dialog.innerHTML)) problems.push('dialog has no install command')
  if (!/data-next/.test(dialog.innerHTML)) problems.push('dialog has no "next" control')
  if (!/class=nav/.test(dialog.innerHTML)) problems.push('dialog has no position indicator')
}

// Sorting, random pick and the grouped filter rail are the new interaction surface.
const sortHtml = element('sort').innerHTML
for (const key of ['stars', 'downloads', 'recent']) {
  if (!sortHtml.includes(`data-sort="${key}"`)) problems.push(`sort switch missing (${key})`)
}
if (!/data-random/.test(sortHtml)) problems.push('random pick button missing')
const declaresEnhance = Object.keys(index.metadata?.categories ?? {}).some((id) => id.startsWith('enhance-'))
if (declaresEnhance && !/class=grp/.test(cats)) problems.push('category rail is not grouped into big categories')

if (problems.length) {
  for (const problem of problems) console.log(`FAIL  ${problem}`)
  process.exit(1)
}
console.log(`PASS  ${cards}/${index.plugins.length} cards, ${(cats.match(/data-cat=/g) ?? []).length} chips, sortable single-language detail`)
