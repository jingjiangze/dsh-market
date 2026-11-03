// Renders the market index in the browser. The page ships no data of its own:
// everything below comes from /index.json (the document DSH itself reads) and
// /stats.json (crawl bookkeeping), so the HTML shell can stay under 1 KB.
const CATEGORY_FALLBACK = { other: { en: 'Other', zh: '其他' } }
const state = { lang: localStorage.getItem('dsh-market-lang') === 'en' ? 'en' : 'zh', category: 'all', query: '', sort: 'name', limit: 80 }
const $ = (id) => document.getElementById(id)
const text = (value, lang) => (typeof value === 'string' ? value : value?.[lang] ?? value?.en ?? '')

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function when(iso) {
  if (!iso) return ''
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000)
  if (Number.isNaN(minutes)) return ''
  const suffix = state.lang === 'zh' ? '前' : ' ago'
  if (minutes < 60) return `${Math.max(minutes, 1)}${state.lang === 'zh' ? ' 分钟' : ' min'}${suffix}`
  if (minutes < 1440) return `${Math.round(minutes / 60)}${state.lang === 'zh' ? ' 小时' : ' h'}${suffix}`
  return `${Math.round(minutes / 1440)}${state.lang === 'zh' ? ' 天' : ' d'}${suffix}`
}

let index = null
let stats = null

function matches(plugin) {
  if (state.category !== 'all' && plugin.metadata?.category !== state.category) return false
  const q = state.query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    plugin.name,
    text(plugin.title, 'en'),
    text(plugin.title, 'zh'),
    text(plugin.description, 'en'),
    text(plugin.description, 'zh'),
    plugin.author ?? '',
    ...(plugin.metadata?.keywords ?? []),
  ].join(' ').toLowerCase()
  return q.split(/\s+/).every((word) => haystack.includes(word))
}

function card(plugin) {
  const version = plugin.versions?.[0]
  const install = `${plugin.name}@${version?.version ?? ''}`
  const category = plugin.metadata?.category ?? 'other'
  const categoryTitle = text(index.metadata?.categories?.[category]?.title, state.lang)
  const icon = plugin.icon ? `<img loading=lazy src="${esc(plugin.icon)}" alt="">` : '<i class=dot></i>'
  const code = esc(install)
  return `<article class=card>${icon}<div class=body><h2>${esc(text(plugin.title, state.lang)) || esc(plugin.name)}</h2><p class=desc>${esc(text(plugin.description, state.lang))}</p><p class=tags><span>${esc(categoryTitle)}</span><span>v${esc(version?.version ?? '')}</span>${plugin.author ? `<span>${esc(plugin.author)}</span>` : ''}</p><p class=row><code>${code}</code><button class=copy data-copy="${code}">复制</button>${plugin.homepage ? `<a href="${esc(plugin.homepage)}" target=_blank rel=noreferrer>主页</a>` : ''}</p></div></article>`
}

function render() {
  if (!index) return
  const plugins = index.plugins.filter(matches).sort((a, b) => {
    if (state.sort === 'recent') return (b.versions?.[0]?.publishTimestamp ?? 0) - (a.versions?.[0]?.publishTimestamp ?? 0)
    return a.name.localeCompare(b.name)
  })

  const counts = new Map()
  for (const plugin of index.plugins) counts.set(plugin.metadata?.category ?? 'other', (counts.get(plugin.metadata?.category ?? 'other') ?? 0) + 1)
  const categories = Object.keys(index.metadata?.categories ?? CATEGORY_FALLBACK)
  $('cats').innerHTML = [`<button class=chip data-cat=all${state.category === 'all' ? ' aria-current=page' : ''}>${state.lang === 'zh' ? '全部' : 'All'} ${index.plugins.length}</button>`]
    .concat(categories.map((id) => `<button class=chip data-cat="${esc(id)}"${state.category === id ? ' aria-current=page' : ''}>${esc(text(index.metadata?.categories?.[id]?.title, state.lang))} ${counts.get(id) ?? 0}</button>`))
    .join('')

  const total = index.plugins.length
  const updated = when(stats?.at)
  const shown = Math.min(state.limit, plugins.length)
  const scope = plugins.length === total ? '' : (state.lang === 'zh' ? ` · 筛选出 ${plugins.length}` : ` · ${plugins.length} matched`)
  $('meta').textContent = state.lang === 'zh'
    ? `${total} 个插件 · ${categories.filter((id) => counts.get(id)).length} 个分类 · 索引更新于 ${updated}${scope}`
    : `${total} plugins · ${categories.filter((id) => counts.get(id)).length} categories · index updated ${updated}${scope}`

  // A four-figure catalog cannot be one DOM dump: render a page and offer more.
  const visible = plugins.slice(0, state.limit)
  $('list').innerHTML = plugins.length
    ? visible.map(card).join('') +
      (plugins.length > visible.length
        ? `<button class=more data-more>${state.lang === 'zh' ? `再显示 ${Math.min(120, plugins.length - shown)} 个（共 ${plugins.length}）` : `Show ${Math.min(120, plugins.length - shown)} more of ${plugins.length}`}</button>`
        : '')
    : `<p class=empty>${state.lang === 'zh' ? '没有匹配的插件' : 'No matching plugins'}</p>`
  $('lang').textContent = state.lang === 'zh' ? 'EN' : '中文'
}

async function main() {
  const [indexRes, statsRes] = await Promise.all([
    fetch('./index.json', { cache: 'no-cache' }),
    fetch('./stats.json', { cache: 'no-cache' }).catch(() => null),
  ])
  index = await indexRes.json()
  stats = statsRes && statsRes.ok ? await statsRes.json() : null
  if (!localStorage.getItem('dsh-market-lang') && (navigator.language ?? '').toLowerCase().startsWith('en')) state.lang = 'en'
  render()
}

document.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-cat]')
  if (chip) {
    state.category = chip.dataset.cat
    state.limit = 80
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
      copy.textContent = state.lang === 'zh' ? '已复制' : 'Copied'
      setTimeout(() => { copy.textContent = state.lang === 'zh' ? '复制' : 'Copy' }, 1200)
    })
    return
  }
  if (event.target.id === 'lang') {
    state.lang = state.lang === 'zh' ? 'en' : 'zh'
    localStorage.setItem('dsh-market-lang', state.lang)
    render()
  }
  if (event.target.id === 'copy') {
    navigator.clipboard?.writeText($('src').textContent.trim()).then(() => {
      event.target.textContent = state.lang === 'zh' ? '已复制' : 'Copied'
      setTimeout(() => { event.target.textContent = state.lang === 'zh' ? '复制索引源' : 'Copy source' }, 1200)
    })
  }
})

$('q').addEventListener('input', (event) => {
  state.query = event.target.value
  state.limit = 80
  render()
})

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== $('q')) {
    event.preventDefault()
    $('q').focus()
  }
})

main().catch((error) => {
  $('meta').textContent = '索引加载失败：' + error.message
})
