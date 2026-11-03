// Browsing layer for the DSH plugin index.
//
// Data: `browse/meta.json` + `browse/<n>.json` chunks (800 compact entries each),
// fetched through three tiers with an 8 s timeout each — ModelScope dataset first,
// jsDelivr second, GitHub Pages last. The 11.5 MB format-1 document is what DSH
// itself reads; the page never downloads it.
const LANGS = ['zh', 'en', 'ja', 'ko', 'ru']
const LANG_LABEL = { zh: '中文', en: 'EN', ja: '日本語', ko: '한국어', ru: 'Русский' }
const PLACEHOLDER = {
  zh: '搜索插件 / 作者 / 关键词',
  en: 'Search plugins, authors, keywords',
  ja: 'プラグイン・作者・キーワードを検索',
  ko: '플러그인 · 작성자 · 키워드 검색',
  ru: 'Поиск плагинов, авторов, ключевых слов',
}
// The four index documents a reader can subscribe to. Picking one only changes
// which link is shown/copied — the list below always shows the whole catalogue.
const INDEX_URL = {
  index: 'https://jingjiangze.github.io/dsh-market/index.json',
  'index.cn': 'https://jingjiangze.github.io/dsh-market/index.cn.json',
  'index.intl': 'https://jingjiangze.github.io/dsh-market/index.intl.json',
  data: 'https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/web/index.json',
}
const IDX_LABEL = { index: '全部', 'index.cn': '国内', 'index.intl': '国际', data: '数据集' }
const TIERS = [
  'https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/web/browse',
  'https://cdn.jsdelivr.net/gh/jingjiangze/dsh-market@main/site/browse',
  'https://jingjiangze.github.io/dsh-market/browse',
]
const SRC_LABEL = { 'src-npm': 'npm', 'src-dshso': 'dsh.so', 'src-awesome': 'awesome', 'src-mydsh': 'mydsh' }
const TRUST_LABEL = { 'trust-readme-verified': 'README 核对', 'trust-repo-fallback': '仓库固定', 'zh-fallback': '中文待补', 'catalog-only': '仅目录', 'no-engines': '未声明版本' }
const SORTS = [['stars', '★ 星标'], ['downloads', '↓ 下载'], ['recent', '◷ 最新'], ['name', 'A-Z']]
const TIMEOUT = 8000

const GUIDE = {
  zh: ['打开 DSH 的「插件」页，切到「发现」。', '点右上角的设置，把下面这条索引源粘进去。', '保存后回到「发现」，插件列表会自动刷新。'],
  en: ['Open Plugins in DSH and switch to Discover.', 'In the settings there, paste the index URL below.', 'Go back to Discover; the list refreshes by itself.'],
  ja: ['DSH の「プラグイン」→「発見」を開きます。', '右上の設定に下の索引 URL を貼り付けます。', '「発見」に戻ると一覧が更新されます。'],
  ko: ['DSH의 플러그인 → 발견을 엽니다.', '오른쪽 위 설정에 아래 인덱스 주소를 붙여 넣습니다.', '발견으로 돌아오면 목록이 갱신됩니다.'],
  ru: ['Откройте «Плагины» → «Обзор» в DSH.', 'В настройках вставьте адрес индекса ниже.', 'Вернитесь в «Обзор» — список обновится.'],
}

const state = { lang: 'zh', copyTarget: 'index', query: '', category: 'all', limit: 60, sort: 'stars', meta: null, plugins: [], tier: -1, open: null, visible: [], guide: false }

const $ = (id) => document.getElementById(id)
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const day = (seconds) => (seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : '')
const num = (value) => (value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value))

function extra(entry, lang) {
  const hit = (entry.x ?? []).find((row) => row[0] === lang)
  return hit ? { title: hit[1], desc: hit[2] } : null
}
const titleOf = (entry) => (state.lang === 'en' ? (entry.e || entry.t) : (extra(entry, state.lang)?.title || entry.t))
const descOf = (entry) => {
  if (state.lang === 'en') return entry.de || entry.d
  return extra(entry, state.lang)?.desc || entry.d || entry.de
}
const catTitle = (id) => {
  const value = state.meta?.categories?.[id]?.title
  return (typeof value === 'string' ? value : value?.[state.lang] ?? value?.en) ?? id
}
const badges = (entry) => [...new Set((entry.l ?? []).map((label) => SRC_LABEL[label] ?? TRUST_LABEL[label] ?? null).filter(Boolean))].slice(0, 3)

function matches(entry) {
  if (state.category !== 'all' && entry.c !== state.category) return false
  const q = state.query.trim().toLowerCase()
  if (!q) return true
  const haystack = [entry.n, entry.t, entry.e, entry.d, entry.de, entry.a ?? '', ...(entry.x ?? []).flat()].join(' ').toLowerCase()
  return q.split(/\s+/).every((word) => haystack.includes(word))
}

function byOrder(a, b) {
  if (state.sort === 'name') return a.n.localeCompare(b.n)
  if (state.sort === 'recent') return (b.p ?? 0) - (a.p ?? 0) || a.n.localeCompare(b.n)
  const key = state.sort === 'downloads' ? 'dl' : 's'
  return (b[key] ?? 0) - (a[key] ?? 0) || a.n.localeCompare(b.n)
}

// Icon chain: the package icon, then the repository owner's avatar (developer),
// then the CSS dot. `onerror` swaps down the chain without extra requests.
function icon(entry) {
  if (entry.i) return `<img loading=lazy src="${esc(entry.i)}"${entry.g ? ` onerror="this.onerror=null;this.src='${esc(entry.g)}'"` : ' onerror="this.remove()"'}>`
  if (entry.g) return `<img loading=lazy src="${esc(entry.g)}" onerror="this.remove()">`
  return '<i class=dot></i>'
}

function card(entry) {
  const tags = [catTitle(entry.c), entry.s ? `★ ${num(entry.s)}` : '', entry.dl ? `↓ ${num(entry.dl)}` : '', entry.v ? `v${entry.v}` : '', entry.a ?? '', day(entry.p)].filter(Boolean)
  const extraTags = badges(entry).map((label) => `<b>${esc(label)}</b>`).join('')
  return `<article class=card data-open="${esc(entry.n)}" tabindex=0>${icon(entry)}<div class=body><h2>${esc(titleOf(entry)) || esc(entry.n)}</h2><p class=desc>${esc(descOf(entry))}</p><p class=meta>${tags.map((tag) => `<span>${esc(tag)}</span>`).join('')}</p>${extraTags ? `<p class=badges>${extraTags}</p>` : ''}</div></article>`
}

function render() {
  if (!state.meta) return
  const pool = state.plugins.filter(matches).sort(byOrder)
  state.visible = pool
  const counts = new Map()
  for (const entry of state.plugins) counts.set(entry.c, (counts.get(entry.c) ?? 0) + 1)
  const chip = (id, label, count) => `<button class=chip data-cat="${esc(id)}"${state.category === id ? ' aria-pressed=true' : ''}><span>${esc(label)}</span><i>${count}</i></button>`
  const parts = [chip('all', IDX_LABEL[state.copyTarget], state.plugins.length)]
  let group = null
  for (const id of Object.keys(state.meta.categories ?? {})) {
    const prefix = id.startsWith('enhance-') ? 'enhance' : id
    if (prefix !== group && prefix === 'enhance') parts.push('<div class=grp>DSH 优化</div>')
    group = prefix
    parts.push(chip(id, catTitle(id), counts.get(id) ?? 0))
  }
  $('cats').innerHTML = parts.join('')
  const buttons = SORTS.map(([id, label]) => `<button data-sort="${id}"${state.sort === id ? ' aria-pressed=true' : ''}>${label}</button>`).join('')
  $('sort').innerHTML = `<span class=sorts>${buttons}</span><button class=dice data-random>🎲 随机</button>`
  const scope = pool.length === state.plugins.length ? '' : ` · 筛出 ${pool.length}`
  const partial = state.tier > 0 ? ` · 备用源 ${state.tier}` : ''
  $('meta').textContent = `${state.plugins.length} 个插件${scope}${partial}`
  $('src').textContent = INDEX_URL[state.copyTarget]
  const visible = pool.slice(0, state.limit)
  $('list').innerHTML = pool.length
    ? visible.map(card).join('') + (pool.length > visible.length ? `<button class=more data-more>再显示 ${Math.min(120, pool.length - visible.length)} 个（共 ${pool.length}）</button>` : '')
    : `<p class=empty>${state.plugins.length ? '没有匹配的插件' : '加载中…'}</p>`
}

function detailHtml(entry) {
  const pairs = [
    ['类别', catTitle(entry.c)],
    ['版本', entry.v],
    ['作者', entry.a],
    ['发布', day(entry.p)],
    ['星标', entry.s ? num(entry.s) : ''],
    ['下载', entry.dl ? num(entry.dl) : ''],
    ['来源', badges(entry).join(' · ')],
    ['包名', entry.n],
  ].filter(([, value]) => value)
  const install = `${entry.n}@${entry.v || ''}`
  const links = [entry.h, entry.r].filter(Boolean)
  const position = state.visible.findIndex((item) => item.n === entry.n)
  const total = state.visible.length
  return `<h3>${esc(titleOf(entry)) || esc(entry.n)}</h3>`
    + `<p class=lead>${esc(descOf(entry))}</p>`
    + `<dl>${pairs.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`
    + `<p class=cmd><code>${esc(install)}</code><button data-copy="${esc(install)}">复制安装</button></p>`
    + (links.length ? `<p class=links>${links.map((url) => `<a href="${esc(url)}" target=_blank rel=noreferrer>${esc(url.replace(/^https?:\/\//, ''))}</a>`).join(' ')}</p>` : '')
    + `<div class=nav><button data-prev${position <= 0 ? ' disabled' : ''}>← 上一个</button><span>${position >= 0 ? position + 1 : '?'} / ${total}</span><button data-next${position < 0 || position + 1 >= total ? ' disabled' : ''}>下一个 →</button></div>`
}

function guideHtml() {
  const steps = (GUIDE[state.lang] ?? GUIDE.zh).map((text, index) => `<li><b>${index + 1}</b>${esc(text)}</li>`).join('')
  const url = INDEX_URL[state.copyTarget]
  return `<h3>接入教程</h3><ol class=guide>${steps}</ol>`
    + `<p class=cmd><code>${esc(url)}</code><button data-copy="${esc(url)}">复制索引源</button></p>`
}

function openDetail(name) {
  const entry = state.plugins.find((item) => item.n === name)
  if (!entry) return
  state.open = name
  state.guide = false
  $('dlg').innerHTML = detailHtml(entry)
  if (!$('dlg').open) $('dlg').showModal()
}

function openGuide() {
  state.guide = true
  $('dlg').innerHTML = guideHtml()
  if (!$('dlg').open) $('dlg').showModal()
}

function withTimeout(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  return fetch(url, { signal: controller.signal, cache: 'no-cache' })
    .then((res) => {
      if (!res.ok) throw new Error(`${res.status}`)
      return res.json()
    })
    .finally(() => clearTimeout(timer))
}

// Try each tier in order; the first one that answers wins and is remembered.
async function fetchTiered(path) {
  const order = state.tier >= 0 ? [state.tier, ...TIERS.keys()].filter((value, index, all) => all.indexOf(value) === index) : [...TIERS.keys()]
  let lastError = null
  for (const index of order) {
    try {
      const body = await withTimeout(`${TIERS[index]}/${path}`)
      state.tier = index
      return body
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('no source')
}

async function loadIndex() {
  try {
    state.meta = await fetchTiered('meta.json')
    state.plugins = []
    for (const chunk of state.meta.chunks ?? []) {
      const slice = await fetchTiered(chunk)
      state.plugins.push(...slice)
      render()
    }
    render()
  } catch (error) {
    $('list').innerHTML = `<p class=empty>索引加载失败：${esc(error.message)}</p>`
  }
}

// The stylesheet is loaded from the dataset too; if that file never applied, fall
// back through the same tiers (jsDelivr, then GitHub Pages) without blocking paint.
function ensureStyles() {
  const applied = [...document.styleSheets].some((sheet) => String(sheet.href ?? '').includes('/a/'))
  if (applied) return
  const fallbacks = [
    'https://cdn.jsdelivr.net/gh/jingjiangze/dsh-market@main/site/style.css',
    'https://jingjiangze.github.io/dsh-market/style.css',
  ]
  for (const href of fallbacks) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    document.head.appendChild(link)
  }
}

document.addEventListener('click', (event) => {
  if (event.target instanceof HTMLElement && event.target.tagName === 'DIALOG') { event.target.close(); return }
  const idxButton = event.target.closest('[data-idx]')
  if (idxButton) {
    for (const button of document.querySelectorAll('[data-idx]')) button.removeAttribute('aria-pressed')
    idxButton.setAttribute('aria-pressed', 'true')
    state.copyTarget = idxButton.dataset.idx
    render()
    return
  }
  if (event.target.closest('[data-guide]')) { openGuide(); return }
  const sortButton = event.target.closest('[data-sort]')
  if (sortButton) { state.sort = sortButton.dataset.sort; state.limit = 60; render(); return }
  if (event.target.closest('[data-random]')) {
    if (!state.visible.length) return
    openDetail(state.visible[Math.floor(Math.random() * state.visible.length)].n)
    return
  }
  const step = event.target.closest('[data-next],[data-prev]')
  if (step) {
    const position = state.visible.findIndex((item) => item.n === state.open)
    if (position < 0) return
    const next = state.visible[event.target.closest('[data-next]') ? position + 1 : position - 1]
    if (next) openDetail(next.n)
    return
  }
  const chip = event.target.closest('[data-cat]')
  if (chip) { state.category = chip.dataset.cat; state.limit = 60; render(); return }
  const more = event.target.closest('[data-more]')
  if (more) { state.limit += 120; render(); return }
  const copy = event.target.closest('[data-copy]')
  if (copy) {
    navigator.clipboard?.writeText(copy.dataset.copy).then(() => flash(copy, '已复制'))
    return
  }
  // Clicking the source row copies it (the whole row is the button).
  if (event.target.closest('.src')) {
    navigator.clipboard?.writeText(INDEX_URL[state.copyTarget]).then(() => flash($('copy'), '已复制'))
    return
  }
  const opened = event.target.closest('[data-open]')
  if (opened) openDetail(opened.dataset.open)
})

function flash(element, text) {
  const before = element.textContent
  element.textContent = text
  setTimeout(() => { element.textContent = before }, 1200)
}

$('list').addEventListener('keydown', (event) => {
  const card = event.target.closest('[data-open]')
  if (card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openDetail(card.dataset.open) }
})
$('q').addEventListener('input', (event) => { state.query = event.target.value; state.limit = 60; render() })
$('lang').addEventListener('change', (event) => {
  state.lang = event.target.value
  localStorage.setItem('dsh-market-lang', state.lang)
  chrome()
  render()
  if ($('dlg').open) (state.guide ? openGuide() : state.open && openDetail(state.open))
})
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== $('q')) { event.preventDefault(); $('q').focus() }
})

function chrome() {
  $('lang').innerHTML = LANGS.map((lang) => `<option value=${lang}>${LANG_LABEL[lang]}</option>`).join('')
  $('lang').value = state.lang
  $('q').placeholder = PLACEHOLDER[state.lang] ?? PLACEHOLDER.en
  // The dataset link is appended here rather than in the HTML: the shell is under
  // 1 KiB and this button costs no bytes that way.
  const seg = document.querySelector?.('.seg')
  if (seg && !seg.querySelector('[data-idx=data]')) {
    const button = document.createElement('button')
    button.dataset.idx = 'data'
    button.textContent = IDX_LABEL.data
    seg.append(button)
  }
}

const saved = localStorage.getItem('dsh-market-lang')
if (LANGS.includes(saved)) state.lang = saved
else if (!String(navigator.language ?? '').toLowerCase().startsWith('zh')) state.lang = 'en'
chrome()
loadIndex()
setTimeout(ensureStyles, TIMEOUT)
