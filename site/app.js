// Renders a market index in the browser. The page ships no data of its own:
// everything comes from /index.json, /index.cn.json or /index.intl.json (each a
// valid DSH format-1 document) plus /stats.json for crawl bookkeeping.
const LANGS = ['zh', 'en', 'ja', 'ko', 'ru']
const IDX_LABEL = { index: '全部', 'index.cn': '国内', 'index.intl': '国际' }
const SRC_LABEL = { 'src-npm': 'npm', 'src-dshso': 'dsh.so', 'src-awesome': 'awesome', 'src-mydsh': 'mydsh' }
const TRUST_LABEL = {
  'trust-readme-verified': 'README 核对',
  'trust-repo-fallback': '仓库固定',
  'trust-unpinned': '未固定',
  'trust-source-index': '目录收录',
}
const state = { lang: 'zh', idx: 'index', query: '', category: 'all', limit: 60, sort: 'stars', data: null, stats: null, open: null }

const $ = (id) => document.getElementById(id)
const pick = (value, lang) => (typeof value === 'string' ? value : (value?.[lang] ?? value?.en ?? value?.zh ?? ''))
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const day = (seconds) => (seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : '')
const base = () => location.origin + location.pathname.replace(/\/[^/]*$/, '/')
const srcUrl = () => `${base()}${state.idx}.json`

function when(iso) {
  if (!iso) return ''
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000)
  if (Number.isNaN(minutes)) return ''
  if (minutes < 60) return `${Math.max(minutes, 1)}m`
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}

function matches(plugin) {
  if (state.category !== 'all' && plugin.metadata?.category !== state.category) return false
  const q = state.query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    plugin.name,
    ...['zh', 'en', 'ja', 'ko', 'ru'].flatMap((lang) => [pick(plugin.title, lang), pick(plugin.description, lang)]),
    plugin.author ?? '',
    ...(plugin.metadata?.keywords ?? []),
  ].join(' ').toLowerCase()
  return q.split(/\s+/).every((word) => haystack.includes(word))
}

function badges(plugin) {
  const labels = plugin.metadata?.labels ?? []
  const sources = labels.filter((label) => label.startsWith('src-')).map((label) => SRC_LABEL[label] ?? label)
  const trust = labels.filter((label) => label.startsWith('trust-')).map((label) => TRUST_LABEL[label] ?? label)
  return [...new Set([...sources, ...trust])].slice(0, 3)
}

function stars(plugin) {
  const value = Number(plugin.metadata?.sortKeys?.stars ?? 0)
  if (!value) return ''
  return value >= 1000 ? `★ ${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : `★ ${value}`
}

// Stars first (that is what a reader wants to see), then the index's own order.
function byOrder(a, b) {
  const sb = Number(b.metadata?.sortKeys?.stars ?? 0)
  const sa = Number(a.metadata?.sortKeys?.stars ?? 0)
  if (sb !== sa) return sb - sa
  return a.name.localeCompare(b.name)
}

function card(plugin) {
  const version = plugin.versions?.[0]
  const icon = plugin.icon ? `<img loading=lazy src="${esc(plugin.icon)}" alt="">` : '<i class=dot></i>'
  const tags = [
    pick(state.data.metadata?.categories?.[plugin.metadata?.category]?.title, state.lang) || '其他',
    stars(plugin),
    version?.version ? `v${version.version}` : '',
    plugin.author ?? '',
    day(version?.publishTimestamp),
  ].filter(Boolean)
  const extra = badges(plugin).map((label) => `<b>${esc(label)}</b>`).join('')
  return `<article class=card data-open="${esc(plugin.name)}" tabindex=0>${icon}<div class=body><h2>${esc(pick(plugin.title, state.lang)) || esc(plugin.name)}</h2><p class=desc>${esc(pick(plugin.description, state.lang))}</p><p class=meta>${tags.map((tag) => `<span>${esc(tag)}</span>`).join('')}</p>${extra ? `<p class=badges>${extra}</p>` : ''}</div></article>`
}

function render() {
  const data = state.data
  if (!data) return
  const plugins = data.plugins.filter(matches).sort(byOrder)
  const counts = new Map()
  for (const plugin of data.plugins) counts.set(plugin.metadata?.category ?? 'other', (counts.get(plugin.metadata?.category ?? 'other') ?? 0) + 1)
  const categories = Object.keys(data.metadata?.categories ?? {})
  $('cats').innerHTML = [`<button class=chip data-cat=all${state.category === 'all' ? ' aria-pressed=true' : ''}>${IDX_LABEL[state.idx]} ${data.plugins.length}</button>`]
    .concat(categories.map((id) => `<button class=chip data-cat="${esc(id)}"${state.category === id ? ' aria-pressed=true' : ''}>${esc(pick(data.metadata?.categories?.[id]?.title, state.lang))} ${counts.get(id) ?? 0}</button>`))
    .join('')
  const scope = plugins.length === data.plugins.length ? '' : ` · 筛出 ${plugins.length}`
  const aged = state.stats?.at ? ` · 更新 ${when(state.stats.at)}前` : ''
  $('meta').textContent = `${data.plugins.length} 个插件${aged}${scope}`
  const visible = plugins.slice(0, state.limit)
  $('list').innerHTML = plugins.length
    ? visible.map(card).join('') +
      (plugins.length > visible.length ? `<button class=more data-more>再显示 ${Math.min(120, plugins.length - visible.length)} 个（共 ${plugins.length}）</button>` : '')
    : '<p class=empty>没有匹配的插件</p>'
}

function dialogHtml(plugin) {
  const version = plugin.versions?.[0]
  const pairs = [
    ['类别', pick(state.data.metadata?.categories?.[plugin.metadata?.category]?.title, state.lang)],
    ['版本', version?.version],
    ['作者', plugin.author],
    ['发布', day(version?.publishTimestamp)],
    ['来源', badges(plugin).join(' · ')],
    ['包名', plugin.name],
  ].filter(([, value]) => value)
  const langs = ['zh', 'en']
  if (!langs.includes(state.lang)) langs.push(state.lang)
  const columns = langs.map((lang) => `<div class=col><h4>${lang === 'zh' ? '中文' : lang === 'en' ? 'English' : lang.toUpperCase()}</h4><p class=colTitle>${esc(pick(plugin.title, lang))}</p><p>${esc(pick(plugin.description, lang))}</p></div>`).join('')
  const install = `${plugin.name}@${version?.version ?? ''}`
  const links = [plugin.homepage, plugin.repository?.url].filter(Boolean)
  return `<h3>${esc(pick(plugin.title, state.lang)) || esc(plugin.name)}</h3><dl>${pairs.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl><div class=dual>${columns}</div><p class=cmd><code>${esc(install)}</code><button data-copy="${esc(install)}">复制安装</button></p>${links.length ? `<p class=links>${links.map((url) => `<a href="${esc(url)}" target=_blank rel=noreferrer>${esc(url.replace(/^https?:\/\//, ''))}</a>`).join(' ')}</p>` : ''}<form method=dialog><button class=close>关闭</button></form>`
}

function openDetail(name) {
  const plugin = state.data?.plugins.find((entry) => entry.name === name)
  if (!plugin) return
  state.open = name
  $('dlg').innerHTML = dialogHtml(plugin)
  if (!$('dlg').open) $('dlg').showModal()
}

async function load(idx) {
  state.idx = idx
  state.data = null
  $('list').innerHTML = '<p class=empty>加载中…</p>'
  try {
    const [dataRes, statsRes] = await Promise.all([
      fetch(`${idx}.json`, { cache: 'no-cache' }),
      fetch('stats.json', { cache: 'no-cache' }).catch(() => null),
    ])
    state.data = await dataRes.json()
    state.stats = statsRes && statsRes.ok ? await statsRes.json() : null
    $('src').textContent = srcUrl()
    render()
  } catch (error) {
    $('list').innerHTML = `<p class=empty>索引加载失败：${esc(error.message)}</p>`
  }
}

document.addEventListener('click', (event) => {
  const idxButton = event.target.closest('[data-idx]')
  if (idxButton) {
    for (const button of document.querySelectorAll('[data-idx]')) button.removeAttribute('aria-pressed')
    idxButton.setAttribute('aria-pressed', 'true')
    state.category = 'all'
    state.limit = 60
    load(idxButton.dataset.idx)
    return
  }
  const chip = event.target.closest('[data-cat]')
  if (chip) {
    state.category = chip.dataset.cat
    state.limit = 60
    render()
    return
  }
  const more = event.target.closest('[data-more]')
  if (more) {
    state.limit += 120
    render()
    return
  }
  const copy = event.target.closest('[data-copy]')
  if (copy) {
    navigator.clipboard?.writeText(copy.dataset.copy).then(() => {
      const before = copy.textContent
      copy.textContent = '已复制'
      setTimeout(() => { copy.textContent = before }, 1200)
    })
    return
  }
  if (event.target.id === 'copy') {
    navigator.clipboard?.writeText($('src').textContent.trim()).then(() => {
      event.target.textContent = '已复制'
      setTimeout(() => { event.target.textContent = '复制' }, 1200)
    })
    return
  }
  const opened = event.target.closest('[data-open]')
  if (opened) openDetail(opened.dataset.open)
})

$('list').addEventListener('keydown', (event) => {
  const card = event.target.closest('[data-open]')
  if (card && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault()
    openDetail(card.dataset.open)
  }
})

$('q').addEventListener('input', (event) => {
  state.query = event.target.value
  state.limit = 60
  render()
})

$('lang').addEventListener('change', (event) => {
  state.lang = event.target.value
  localStorage.setItem('dsh-market-lang', state.lang)
  render()
  if (state.open && $('dlg').open) openDetail(state.open)
})

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== $('q')) {
    event.preventDefault()
    $('q').focus()
  }
})

const saved = localStorage.getItem('dsh-market-lang')
if (LANGS.includes(saved)) state.lang = saved
else if (!String(navigator.language ?? '').toLowerCase().startsWith('zh')) state.lang = 'en'
$('lang').value = state.lang
load('index')
