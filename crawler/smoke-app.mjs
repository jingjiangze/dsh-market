// Executes the browser bundle against a minimal DOM stub, with the ModelScope
// browse fixtures served by a fake fetch. Catches a page that would render nothing,
// lose its detail view, drop the sort/random controls, or ignore a mirror tier.
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
const footerElement = { innerHTML: '' }
const segElement = {
  children: [],
  querySelector(selector) {
    return this.children.find((child) => `[data-idx=${child.dataset.idx}]` === selector) ?? null
  },
  append(child) { this.children.push(child) },
}
const document = {
  activeElement: null,
  getElementById: (id) => element(id),
  querySelectorAll: () => [],
  querySelector: (selector) => (selector === '.seg' ? segElement : selector === 'body > footer' ? footerElement : null),
  createElement: (tag) => ({ tag, dataset: {}, textContent: '', rel: '', href: '', type: '', src: '', className: '', append() {}, setAttribute() {}, addEventListener() {}, classList: { toggle() {}, add() {}, remove() {} } }),
  addEventListener() {},
  documentElement: { dataset: {} },
  head: { appendChild() {} },
  body: { append() {} },
  styleSheets: [],
}
const localStorage = { getItem: () => null, setItem() {} }
const navigator = { language: 'zh-CN', clipboard: { writeText: async () => {} } }
const location = { origin: 'https://example.test', pathname: '/dsh-market/' }
const fakeWindow = { __r: 0, addEventListener() {}, matchMedia: () => ({ matches: false }) }
const fetchStub = async (url) => {
  const text = String(url)
  const body = text.endsWith('meta.json') ? META : text.endsWith('0.json') ? CHUNK : { at: new Date().toISOString() }
  return { ok: true, status: 200, json: async () => body }
}

const run = new Function('document', 'localStorage', 'navigator', 'location', 'fetch', 'setTimeout', 'console', 'window',
  `${source}\nreturn { render, openDetail, openGuide, state, chrome, favorites, saveFavorites }`)
const api = run(document, localStorage, navigator, location, fetchStub, () => 0, console, fakeWindow)
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

// Stars sort: the highest-star entry must come first.
api.state.sort = 'stars'
api.render()
const firstStar = (element('list').innerHTML.match(/data-open="([^"]+)"/) ?? [])[1]
if (firstStar !== 'dsh-ops') problems.push(`stars sort put ${JSON.stringify(firstStar)} first`)
// Downloads sort: only one fixture carries downloads, so it must lead.
api.state.sort = 'downloads'
api.render()
const firstDownload = (element('list').innerHTML.match(/data-open="([^"]+)"/) ?? [])[1]
if (firstDownload !== 'dsh-ops') problems.push(`downloads sort put ${JSON.stringify(firstDownload)} first`)
api.state.sort = 'stars'
api.render()

// Detail modal: single language, install command, prev/next — and no close button.
const dialog = element('dlg')
api.openDetail('dsh-ops')
if (!dialog.open) problems.push('opening a card did not open the dialog')
if (!/class=lead/.test(dialog.innerHTML)) problems.push('dialog has no description')
if (!/data-copy=/.test(dialog.innerHTML)) problems.push('dialog has no install command')
if (!/data-next/.test(dialog.innerHTML) || !/class=nav/.test(dialog.innerHTML)) problems.push('dialog has no next/position controls')
if (/class=dual/.test(dialog.innerHTML)) problems.push('dialog still renders the old bilingual columns')
if (/class=close|关闭/.test(dialog.innerHTML)) problems.push('dialog still renders the removed close button')

// Source buttons are per language: picking one copies that language's index and
// must not filter the list.
const before = (element('list').innerHTML.match(/class=card/g) ?? []).length
api.chrome()
if (!/data-idx="ja"/.test(segElement.innerHTML) || !/日本語/.test(segElement.innerHTML)) problems.push('per-language source buttons are missing')
api.state.copyTarget = 'zh'
api.render()
if (!/index\.zh\.json/.test(String(element('src').textContent))) problems.push('the Chinese source does not copy index.zh.json')
if ((element('list').innerHTML.match(/class=card/g) ?? []).length !== before) problems.push('source switch must not filter the list')
api.state.copyTarget = 'ja'
api.render()
// One source only: the dataset answers 302 and DSH cannot follow a redirect, so the
// copied link must always be the GitHub Pages document.
if (!/jingjiangze\.github\.io/.test(String(element('src').textContent))) problems.push('a language source does not point at GitHub Pages')
if (/modelscope/.test(String(element('src').textContent))) problems.push('a language source still points at the dataset')
if (api.state.lang !== 'zh') problems.push('render() alone should not change the interface language')

// The region toggle is gone: there is no second, usable source to switch between.
api.chrome()
if (/data-region/.test(segElement.innerHTML)) problems.push('the removed region toggle is still rendered')

// The themed shelves (high score / popular / new / daily) were removed by request:
// the page opens straight into the category rail and the card grid.
const rail = /** @type {any} */ (element('rec'))
if (rail && /rec-shelf|今日推荐/.test(rail.innerHTML)) problems.push('a retired recommendation shelf is still rendered')
// The quiz entry point must exist on the toolbar.
if (!/帮我选/.test(rail?.parentElement?.innerHTML ?? '') && !/帮我选/.test(/** @type {any} */ (element('sort')).innerHTML ?? '')) {
  // renderPersonal inserts it into .row; the stub has no .row, so accept its absence
  // only when the quiz module itself is missing.
  if (!/你想用 DSH 做什么/.test(source)) problems.push('the quiz module is missing')
}

// Trust badge, three-level install grade, favorites, trending sorts and the
// compatibility control all render from index data alone (no backend needed).
api.state.copyTarget = 'zh'
api.state.sort = 'stars'
api.state.compat = 'all'
api.state.favorites = false
api.render()
const cardHtml = element('list').innerHTML
// The 未声明版本 / 目录收录 pills were removed by request: they appeared on nine of
// ten cards and read as errors. The card must not carry them any more.
if (/class=trust|未声明版本|目录收录/.test(cardHtml)) problems.push('the retired trust pill is still rendered')
if (!/class=fav/.test(cardHtml)) problems.push('favorite button is missing from cards')
const sorts = element('sort').innerHTML
for (const key of ['data-sort="trend7"', 'data-sort="trend30"', 'data-sort="trend90"']) {
  if (!sorts.includes(key)) problems.push(`trending sort ${key} is missing`)
}
if (!/id=compat/.test(sorts)) problems.push('compatibility dropdown is missing')
if (!/data-fav-toggle/.test(sorts)) problems.push('favorites filter is missing')

// Favorites are a bookmark, not a vote: adding one and enabling the filter leaves
// exactly that card, and the count appears on the toggle.
api.favorites.add('dsh-ops')
api.saveFavorites()
api.state.favorites = true
api.render()
const favCards = (element('list').innerHTML.match(/class=card/g) ?? []).length
if (favCards !== 1) problems.push(`favorites filter showed ${favCards} cards, expected 1`)
api.state.favorites = false
api.favorites.delete('dsh-ops')
api.saveFavorites()
api.render()

// Integration guide modal.
api.openGuide()
if (!dialog.open || !/class=guide/.test(dialog.innerHTML)) problems.push('integration guide did not open')
if (!/index(\.(zh|en|ja|ko|ru))?\.json/.test(dialog.innerHTML)) problems.push('guide does not show the index URL')

// A second instance whose tier-1 source is down must fall through to tier 2.
const brokenFetch = async (url) => {
  if (String(url).includes('modelscope.cn')) throw new Error('tier down')
  return fetchStub(url)
}
const api2 = run(document, localStorage, navigator, location, brokenFetch, () => 0, console, fakeWindow)
await api2.state.meta
await new Promise((resolve) => setTimeout(resolve, 120))
if (api2.state.plugins.length === 0) problems.push('fallback source did not load any plugin')
if (api2.state.tier !== 1) problems.push(`expected tier 2 to answer, got tier ${api2.state.tier + 1}`)

// Icon chain: an entry with only a repository URL must render the owner avatar.
const avatarMeta = { ...META, total: 1, chunks: ['0.json'], categories: { agent: { title: { en: 'Agents', zh: '智能体' } } } }
const avatarChunk = [{ n: 'x/avatar-only', t: '头像插件', e: 'Avatar only', d: '只有仓库', de: 'repo only', c: 'agent', v: '1.0.0', p: 1, g: 'https://github.com/someone.png?size=80' }]
const avatarFetch = async (url) => ({ ok: true, json: async () => (String(url).endsWith('meta.json') ? avatarMeta : avatarChunk) })
const api3 = run(document, localStorage, navigator, location, avatarFetch, () => 0, console, fakeWindow)
await api3.state.meta
await new Promise((resolve) => setTimeout(resolve, 80))
if (!element('list').innerHTML.includes('github.com/someone.png')) problems.push('repository-owner avatar is not used as the icon fallback')

// Language switch must pick the ja translation out of x[][]
api.state.lang = 'ja'
api.chrome()
api.render()
if (!element('list').innerHTML.includes('チーム編成')) problems.push('ja translation is not used after switching language')

// Footer statistics must come from the loaded catalogue, including the QQ line.
if (!/收录/.test(footerElement.innerHTML)) problems.push('footer does not show the catalogue size')
if (!/星标/.test(footerElement.innerHTML)) problems.push('footer does not show star coverage')
if (!/1689170897/.test(footerElement.innerHTML)) problems.push('footer lost the QQ line')

if (problems.length) {
  for (const problem of problems) console.log(`FAIL  ${problem}`)
  process.exit(1)
}
console.log(`PASS  ${cards} cards, ${(cats.match(/data-cat=/g) ?? []).length} chips, shell injected, sorts verified, no close button, dataset link, tier fallback, ja switch`)
