// Executes the browser bundle against a minimal DOM stub, with the ModelScope
// browse fixtures served by a fake fetch. Catches a page that would render nothing,
// lose its detail view, or quietly drop the sort/random controls.
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(join(root, 'site', 'app.js'), 'utf8')

const META = {
  updatedAt: new Date().toISOString(),
  total: 4,
  chunk: 800,
  chunks: ['0.json'],
  categories: {
    'enhance-models': { title: { en: 'Model providers', zh: '模型与供应商' } },
    'enhance-ui': { title: { en: 'Interface & themes', zh: '界面与主题' } },
    agent: { title: { en: 'Agents', zh: '智能体与编排' } },
  },
  sortKeys: { stars: { order: 'desc' }, downloads: { order: 'desc' } },
}
const CHUNK = [
  { n: 'dsh-ops', t: '运维面板', e: 'Ops panel', d: '集群运维与审计视图', de: 'Cluster ops and audit view', c: 'enhance-ui', v: '1.2.0', p: 1790000000, s: 5060, dl: 1200, l: ['src-dshso', 'catalog-only'], a: 'jingjiangze', r: 'https://github.com/jingjiangze/dsh-ops' },
  { n: 'dsh-context', t: '上下文透镜', e: 'Context lens', d: '把代码压成语义骨架', de: 'Compress code into a semantic skeleton', c: 'enhance-models', v: '0.4.1', p: 1789000000, s: 4006, l: ['src-awesome'] },
  { n: '@scope/dsh-team', t: '团队编排', e: 'Team orchestration', d: '多智能体编排', de: 'Multi-agent orchestration', c: 'agent', v: '2.0.0', p: 1788000000, s: 12, l: ['src-npm', 'zh-fallback'], x: [['ja', 'チーム編成', 'マルチエージェント編成']] },
  { n: 'dsh-plain', t: '小工具', e: 'Small tool', d: '一个很小的工具', de: 'A small tool', c: 'agent', v: '1.0.0', p: 1787000000 },
]

const elements = new Map()
function element(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      id, textContent: '', innerHTML: '', value: '', dataset: {}, open: false, placeholder: '',
      addEventListener() {}, focus() {},
      showModal() { this.open = true }, close() { this.open = false },
    })
  }
  return elements.get(id)
}
const document = { activeElement: null, getElementById: (id) => element(id), querySelectorAll: () => [], addEventListener() {} }
const localStorage = { getItem: () => null, setItem() {} }
const navigator = { language: 'zh-CN', clipboard: { writeText: async () => {} } }
const location = { origin: 'https://example.test', pathname: '/dsh-market/' }
const fetchStub = async (url) => {
  const text = String(url)
  const body = text.endsWith('meta.json') ? META : text.endsWith('0.json') ? CHUNK : { at: new Date().toISOString() }
  return { ok: true, status: 200, json: async () => body }
}

const run = new Function('document', 'localStorage', 'navigator', 'location', 'fetch', 'setTimeout', 'console',
  `${source}\nreturn { render, openDetail, state, chrome }`)
const api = run(document, localStorage, navigator, location, fetchStub, () => 0, console)
await api.state.meta
await new Promise((resolve) => setTimeout(resolve, 120))

const problems = []
const list = element('list').innerHTML
const meta = element('meta').textContent
const cats = element('cats').innerHTML
const sortHtml = element('sort').innerHTML
const cards = (list.match(/class=card/g) ?? []).length

if (!api.state.meta) problems.push('meta.json was never fetched')
if (cards === 0) problems.push('no plugin card rendered')
if (!meta.includes(String(META.total))) problems.push(`header does not show the total: ${JSON.stringify(meta)}`)
if (!list.includes('data-open=')) problems.push('cards are not clickable')
for (const key of ['stars', 'downloads', 'recent']) if (!sortHtml.includes(`data-sort="${key}"`)) problems.push(`sort switch missing (${key})`)
if (!/data-random/.test(sortHtml)) problems.push('random pick button missing')
if (!/class=grp/.test(cats)) problems.push('category rail is not grouped under DSH 优化')
if ((cats.match(/data-cat=/g) ?? []).length < 3) problems.push('category chips missing')

// Detail drawer: single language, install command, prev/next, position.
const dialog = element('dlg')
api.openDetail('dsh-ops')
if (!dialog.open) problems.push('opening a card did not open the dialog')
if (!/class=lead/.test(dialog.innerHTML)) problems.push('dialog has no description')
if (!/data-copy=/.test(dialog.innerHTML)) problems.push('dialog has no install command')
if (!/data-next/.test(dialog.innerHTML) || !/class=nav/.test(dialog.innerHTML)) problems.push('dialog has no next/position controls')
if (/class=dual/.test(dialog.innerHTML)) problems.push('dialog still renders the old bilingual columns')

// Source segments must filter instead of refetching a different document.
api.state.idx = 'index.cn'
api.render()
const cnCards = (element('list').innerHTML.match(/class=card/g) ?? []).length
api.state.idx = 'index.intl'
api.render()
const intlCards = (element('list').innerHTML.match(/class=card/g) ?? []).length
if (cnCards !== 1) problems.push(`domestic segment should show 1 entry, showed ${cnCards}`)
if (intlCards !== 2) problems.push(`international segment should show 2 entries, showed ${intlCards}`)

// Language switch must pick the ja translation out of x[][]
api.state.lang = 'ja'
api.chrome()
api.render()
if (!element('list').innerHTML.includes('チーム編成')) problems.push('ja translation is not used after switching language')

if (problems.length) {
  for (const problem of problems) console.log(`FAIL  ${problem}`)
  process.exit(1)
}
console.log(`PASS  ${cards} cards, ${(cats.match(/data-cat=/g) ?? []).length} chips, chunked load, segments filter, ja switch, detail nav`)
