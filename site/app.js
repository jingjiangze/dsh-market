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
// Subscription links are two-dimensional: region × language.
//   国内源 (ModelScope dataset, fast inside China, unreachable abroad)
//   国外源 (GitHub Pages, reachable everywhere)
// Each language has one document in each region, so a reader who wants Japanese can
// subscribe to exactly the Japanese catalogue that their network can download.
const DATASET = 'https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/web'
const PAGES = 'https://jingjiangze.github.io/dsh-market'
const IDX_LABEL = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어', ru: 'Русский' }

function inChina() {
  const tz = String(Intl.DateTimeFormat().resolvedOptions().timeZone ?? '')
  const lang = String(navigator.language ?? '').toLowerCase()
  return /Asia\/(Shanghai|Chongqing|Harbin|Urumqi|Hong_Kong|Macau|Taipei)$/.test(tz) || lang.startsWith('zh')
}

function indexUrl(lang = state.copyTarget) {
  // One source only. The ModelScope dataset answers 302 to its CDN and DSH rejects
  // redirects, so a dataset link is a link nobody can subscribe to; GitHub Pages
  // serves the same document directly (gzip, ~1.2 MB, ~2 s from China).
  return `${PAGES}/index.${lang}.json`
}

// Data comes from the same region the reader picked; the other mirrors stay as
// fallbacks so a blocked dataset or a cold jsDelivr does not break the page.
function tiersFor(region = inChina() ? 'cn' : 'intl') {
  return region === 'cn'
    ? [`${DATASET}/browse`, 'https://cdn.jsdelivr.net/gh/jingjiangze/dsh-market@main/site/browse', `${PAGES}/browse`]
    : [`${PAGES}/browse`, 'https://cdn.jsdelivr.net/gh/jingjiangze/dsh-market@main/site/browse', `${DATASET}/browse`]
}
const SRC_LABEL = { 'src-npm': 'npm', 'src-dshso': 'dsh.so', 'src-awesome': 'awesome', 'src-mydsh': 'mydsh' }
const TRUST_LABEL = {
  'trust-readme-verified': 'README 核对',
  'trust-repo-fallback': '仓库固定',
  'zh-fallback': '中文待补',
  'catalog-only': '仅目录',
  'no-engines': '未声明版本',
  // popularity tiers published by the crawler
  'stars-hot': '★ 1k+',
  'stars-mid': '★ 100+',
  'stars-new': '★ <100',
  'dl-hot': '↓ 1k+',
  'dl-mid': '↓ 100+',
  'install-verified': '已验证安装',
}
const SORTS = [['stars', '★ 星标'], ['downloads', '↓ 下载'], ['recent', '◷ 最新'], ['name', 'A-Z']]
const TIMEOUT = 8000

const GUIDE = {
  zh: ['打开 DSH 的「插件」页，切到「发现」。', '点右上角的设置，把下面这条索引源粘进去。', '保存后回到「发现」，插件列表会自动刷新。'],
  en: ['Open Plugins in DSH and switch to Discover.', 'In the settings there, paste the index URL below.', 'Go back to Discover; the list refreshes by itself.'],
  ja: ['DSH の「プラグイン」→「発見」を開きます。', '右上の設定に下の索引 URL を貼り付けます。', '「発見」に戻ると一覧が更新されます。'],
  ko: ['DSH의 플러그인 → 발견을 엽니다.', '오른쪽 위 설정에 아래 인덱스 주소를 붙여 넣습니다.', '발견으로 돌아오면 목록이 갱신됩니다.'],
  ru: ['Откройте «Плагины» → «Обзор» в DSH.', 'В настройках вставьте адрес индекса ниже.', 'Вернитесь в «Обзор» — список обновится.'],
}

const state = { lang: 'zh', copyTarget: 'zh', query: '', category: 'all', limit: 60, sort: 'stars', meta: null, plugins: [], tier: Number(localStorage.getItem('dsh-market-tier') ?? -1), open: null, visible: [], guide: false }

// ---- personal state: the installed set ---------------------------------------
// Only what is installed on this machine. It stays in this browser; the site is
// static and deliberately runs no server, so nothing is uploaded anywhere.
const INSTALLED_KEY = 'dsh-market-installed'
const readStore = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback } catch { return fallback } }
const installed = readStore(INSTALLED_KEY, {})
const saveInstalled = () => { try { localStorage.setItem(INSTALLED_KEY, JSON.stringify(installed)) } catch {} }
const isInstalled = (name) => Object.prototype.hasOwnProperty.call(installed, name)



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
const badges = (entry) => [...new Set((entry.l ?? []).map((label) => SRC_LABEL[label] ?? TRUST_LABEL[label] ?? null).filter(Boolean))].slice(0, 4)

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
// One helper for both views: try each URL in order, and when the chain runs out
// swap the <img> for the CSS dot — an <img> with no valid source shows the
// browser's broken-image box, which is exactly what a wrong avatar looked like.
function imgChain(chain, attributes) {
  const urls = chain.filter(Boolean)
  if (!urls.length) return ''
  return `<img ${attributes} src="${esc(urls[0])}" data-chain="${esc(urls.slice(1).join('|'))}" onerror="var c=this.dataset.chain;if(!c){this.outerHTML='<i class=dot></i>';return}var p=c.split('|');this.dataset.chain=p.slice(1).join('|');this.src=p[0]">`
}

function icon(entry) {
  return imgChain([entry.i, entry.ib, entry.g, entry.gb], 'loading=lazy') || '<i class=dot></i>'
}

function card(entry) {
  const tags = [catTitle(entry.c), entry.s ? `★ ${num(entry.s)}` : '', entry.dl ? `↓ ${num(entry.dl)}` : '', entry.v ? `v${entry.v}` : '', entry.a ?? '', day(entry.p)].filter(Boolean)
  const extraTags = badges(entry).map((label) => `<b>${esc(label)}</b>`).join('')
  const owned = isInstalled(entry.n)
  const upgrade = owned && installed[entry.n] && entry.v && String(installed[entry.n]) !== String(entry.v)
  const own = [owned ? `<b class=own>已装 ${esc(installed[entry.n] ?? '')}</b>` : '', upgrade ? '<b class=up>可升级</b>' : ''].join('')
  return `<article class=card data-open="${esc(entry.n)}" tabindex=0>${icon(entry)}<div class=body><h2>${esc(titleOf(entry)) || esc(entry.n)}</h2><p class=desc>${esc(descOf(entry))}</p><p class=meta>${tags.map((tag) => `<span>${esc(tag)}</span>`).join('')}</p>${extraTags || own ? `<p class=badges>${extraTags}${own}</p>` : ''}</div></article>`
}

// The personal layer: what this browser says about the catalogue (votes) and what is
// actually installed (a directory scan or an imported file). It renders two strips
// above the list — a status bar and a "for you" rail — and both stay hidden until the
// reader has given at least one signal, so a first visit looks exactly as before.
function renderPersonal(pool) {
  const ownedNames = Object.keys(installed)
  const upgradable = ownedNames.filter((name) => {
    const entry = state.plugins.find((item) => item.n === name)
    return entry && entry.v && String(installed[name]) !== String(entry.v)
  }).length
  const unknown = ownedNames.filter((name) => !state.plugins.some((item) => item.n === name)).length

  let bar = document.getElementById('ins')
  if (!bar) {
    bar = document.createElement('div')
    bar.id = 'ins'
    bar.className = 'ins'
    const row = document.querySelector('.row')
    row?.parentElement?.insertBefore(bar, row.nextSibling)
  }
  bar.innerHTML = `<span class=ins-stat>已装 <b>${ownedNames.length}</b>${upgradable ? ` · <b class=up>${upgradable}</b> 可升级` : ''}${unknown ? ` · <b>${unknown}</b> 未收录` : ''}</span>
    <button class=ins-btn data-scan>扫描已安装</button>
    <button class=ins-btn data-import-input>导入 JSON</button>
    <input type=file id=importFile accept="application/json,.json" hidden>`

  let rail = document.getElementById('rec')
  if (!rail) {
    rail = document.createElement('div')
    rail.id = 'rec'
    rail.className = 'rec'
    const wrap = document.querySelector('.wrap')
    wrap?.parentElement?.insertBefore(rail, wrap)
  }
  // Six entries chosen by today's date: the same rail all day, different tomorrow.
  // It never depends on the reader, so it shows up on a first visit too.
  const today = new Date()
  const seedKey = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`
  let seed = 2166136261
  for (const ch of seedKey) seed = ((seed ^ ch.charCodeAt(0)) * 16777619) >>> 0
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  const bag = pool.slice()
  const picks = []
  for (let i = 0; i < 6 && bag.length; i++) picks.push(bag.splice(Math.floor(rand() * bag.length), 1)[0])
  rail.innerHTML = picks.length
    ? `<h3>今日推荐 <i>${seedKey}</i></h3><div class=rec-row>${picks.map((entry) => `<button class=rec-item data-open="${esc(entry.n)}">${esc(titleOf(entry)) || esc(entry.n)}<i>${esc(catTitle(entry.c))}</i></button>`).join('')}</div>`
    : ''
}

// Reads a DSH profile directory in the browser: walk for `node_modules`, then keep
// the packages whose package.json carries a dsh section or a dsh keyword. Chrome and
// Edge expose showDirectoryPicker; other browsers use the JSON import instead.
async function scanInstalled() {
  if (!window.showDirectoryPicker) {
    alert('这个浏览器不支持直接读取目录，请用「导入 JSON」。')
    return null
  }
  const root = await window.showDirectoryPicker({ id: 'dsh-profile', mode: 'read' })
  const found = {}
  const readPackage = async (dirHandle, fallbackName) => {
    try {
      const file = await dirHandle.getFileHandle('package.json')
      const pkg = JSON.parse(await (await file.getFile()).text())
      const words = Array.isArray(pkg.keywords) ? pkg.keywords.map((word) => String(word).toLowerCase()) : []
      const isDsh = Boolean(pkg.dsh) || words.includes('dsh-plugin') || words.some((word) => word.startsWith('dsh-'))
      if (isDsh) found[pkg.name || fallbackName] = pkg.version || ''
    } catch { /* not a package */ }
  }
  const readModules = async (modules) => {
    for await (const [name, handle] of modules.entries()) {
      if (handle.kind !== 'directory') continue
      if (name.startsWith('@')) {
        for await (const [scoped, scopedHandle] of handle.entries()) {
          if (scopedHandle.kind === 'directory') await readPackage(scopedHandle, `${name}/${scoped}`)
        }
      } else {
        await readPackage(handle, name)
      }
    }
  }
  const walk = async (dir, depth) => {
    if (depth > 5) return
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'directory' || name.startsWith('.')) continue
      if (name === 'node_modules') { await readModules(handle); continue }
      await walk(handle, depth + 1)
    }
  }
  await walk(root, 0)
  return found
}

function render() {
  if (!state.meta) return
  const pool = state.plugins.filter(matches).sort(byOrder)
  state.visible = pool
  const counts = new Map()
  for (const entry of state.plugins) counts.set(entry.c, (counts.get(entry.c) ?? 0) + 1)
  const chip = (id, label, count) => `<button class=chip data-cat="${esc(id)}"${state.category === id ? ' aria-pressed=true' : ''}><span>${esc(label)}</span><i>${count}</i></button>`
  // The header reports the catalogue total, not what happens to be in memory:
  // chunks load progressively, and "1,500" looked like the whole catalogue.
  const total = state.meta.total ?? state.plugins.length
  const parts = [chip('all', IDX_LABEL[state.copyTarget], total)]
  let group = null
  for (const id of Object.keys(state.meta.categories ?? {})) {
    const prefix = id.startsWith('enhance-') ? 'enhance' : id
    if (prefix !== group && prefix === 'enhance') parts.push('<div class=grp>DSH 优化</div>')
    group = prefix
    parts.push(chip(id, catTitle(id), counts.get(id) ?? 0))
  }
  $('cats').innerHTML = parts.join('')
  // On a phone the rail is a horizontal strip: keep the selected chip in view.
  try {
    document.querySelector('.chip[aria-pressed]')?.scrollIntoView({ inline: 'center', block: 'nearest' })
  } catch {}
  const buttons = SORTS.map(([id, label]) => `<button data-sort="${id}"${state.sort === id ? ' aria-pressed=true' : ''}>${label}</button>`).join('')
  $('sort').innerHTML = `<span class=sorts>${buttons}</span><button class=dice data-random>🎲 随机</button>`
  const scope = pool.length === state.plugins.length ? '' : ` · 筛出 ${pool.length}`
  const loaded = state.plugins.length < total ? ` · 已载入 ${state.plugins.length}/${total}` : ''
  const partial = state.tier > 0 ? ` · 备用源 ${state.tier}` : ''
  $('meta').textContent = `${total} 个插件${loaded}${scope}${partial}`
  $('src').textContent = indexUrl(state.copyTarget)
  renderPersonal(pool)
  renderFooter()
  const visible = pool.slice(0, state.limit)
  $('list').innerHTML = pool.length
    ? visible.map(card).join('') + (pool.length > visible.length ? `<button class=more data-more>再显示 ${Math.min(120, pool.length - visible.length)} 个（共 ${pool.length}）</button>` : '')
    : `<p class=empty>${state.plugins.length ? '没有匹配的插件' : '加载中…'}</p>`
}

// Footer states what the catalogue actually contains, because "10,995 plugins" says
// nothing about how many carry stars, downloads or a translation.
function renderFooter() {
  const footer = document.querySelector?.('body > footer')
  const items = state.plugins
  if (!footer || !items.length) return
  const withStars = items.filter((entry) => entry.s > 0).length
  const withDownloads = items.filter((entry) => entry.dl > 0).length
  const translated = items.filter((entry) => (entry.x ?? []).length > 0).length
  const categories = Object.keys(state.meta?.categories ?? {}).length
  const pct = (value) => `${Math.round((value / items.length) * 100)}%`
  const updated = state.meta?.updatedAt ? day(Date.parse(state.meta.updatedAt) / 1000) : ''
  const parts = [
    `收录 ${items.length}`,
    `${categories} 个分类`,
    `星标 ${withStars}（${pct(withStars)}）`,
    `下载量 ${withDownloads}（${pct(withDownloads)}）`,
    `多语言 ${translated}（${pct(translated)}）`,
    updated ? `更新 ${updated}` : '',
    '交流 QQ：1689170897',
  ].filter(Boolean)
  footer.innerHTML = parts.map((text) => `<span>${esc(text)}</span>`).join('<i>·</i>')
}

// The detail view shows a larger icon and walks the full chain the reader asked
// for: package icon → the project's GitHub artwork → the developer's avatar.
function heroIcon(entry) {
  return imgChain([entry.i, entry.ib, entry.g, entry.gb], 'class=hicon')
}

const ZH_SOURCE = { native: '包自带中文', override: '人工整理', catalog: '目录提供', detected: '作者原文', fallback: '暂用英文' }

function detailHtml(entry) {
  const pairs = [
    ['类别', catTitle(entry.c)],
    ['版本', entry.v],
    ['作者', entry.a],
    ['发布', day(entry.p)],
    ['星标', entry.s ? num(entry.s) : ''],
    ['下载', entry.dl ? `↓ ${num(entry.dl)}` : ''],
    ['DSH 版本', entry.eg],
    ['安装体积', entry.sz ? `${entry.sz} MB` : ''],
    ['中文来源', ZH_SOURCE[entry.zh] ?? ''],
    ['收录位数', entry.on ? `${entry.on} 个目录` : ''],
    ['校验', entry.dg ? `完整性✓${entry.at ? ' 签名✓' : ''}` : ''],
    ['来源', badges(entry).join(' · ')],
    ['包名', entry.n],
  ].filter(([, value]) => value)
  const install = `${entry.n}@${entry.v || ''}`
  const links = [entry.h, entry.r].filter(Boolean)
  const keywords = (entry.kw ?? []).map((word) => `<b>${esc(word)}</b>`).join('')
  const position = state.visible.findIndex((item) => item.n === entry.n)
  const total = state.visible.length
  const updated = state.meta?.updatedAt ? day(Date.parse(state.meta.updatedAt) / 1000) : ''
  return `<div class=dh>${heroIcon(entry)}<h3>${esc(titleOf(entry)) || esc(entry.n)}</h3></div>`
    + `<p class=lead>${esc(descOf(entry))}</p>`
    + `<dl>${pairs.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`
    + `<p class=cmd><code>${esc(install)}</code><button data-copy="${esc(install)}">复制安装</button></p>`
    + (keywords ? `<p class=kw>${keywords}</p>` : '')
    + (links.length ? `<p class=links>${links.map((url) => `<a href="${esc(url)}" target=_blank rel=noreferrer>${esc(url.replace(/^https?:\/\//, ''))}</a>`).join(' ')}</p>` : '')
    + (updated ? `<p class=stamp>目录更新于 ${esc(updated)}</p>` : '')
    + `<div class=nav><button data-prev${position <= 0 ? ' disabled' : ''}>← 上一个</button><span>${position >= 0 ? position + 1 : '?'} / ${total}</span><button data-next${position < 0 || position + 1 >= total ? ' disabled' : ''}>下一个 →</button></div>`
}

function guideHtml() {
  const steps = (GUIDE[state.lang] ?? GUIDE.zh).map((text, index) => `<li><b>${index + 1}</b>${esc(text)}</li>`).join('')
  const url = indexUrl(state.copyTarget)
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
  const tiers = tiersFor()
  const order = state.tier >= 0
    ? [state.tier, ...[...tiers.keys()]].filter((value, index, all) => all.indexOf(value) === index)
    : [...tiers.keys()]
  let lastError = null
  for (const index of order) {
    try {
      const body = await withTimeout(`${tiers[index]}/${path}`)
      state.tier = index
      // Remember which mirror worked, so the next visit starts there instead of
      // paying the dataset timeout from abroad.
      try { localStorage.setItem('dsh-market-tier', String(index)) } catch {}
      return body
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('no source')
}

// The whole catalogue is ~7 MB across ~44 chunks. The first chunk paints at once,
// then every remaining chunk is pulled six at a time so the list, the search and the
// counts all end up covering the full catalogue instead of a partial slice.
const PARALLEL_CHUNKS = 6

async function loadIndex() {
  try {
    state.meta = await fetchTiered('meta.json')
    state.plugins = []
    state.loaded = 0
    const chunks = state.meta.chunks ?? []
    if (!chunks.length) return render()

    const first = await fetchTiered(chunks[0]).catch(() => null)
    if (first) {
      state.plugins.push(...first)
      state.loaded = 1
      render()
    }

    let cursor = 1
    const worker = async () => {
      while (cursor < chunks.length) {
        const chunk = chunks[cursor++]
        const slice = await fetchTiered(chunk).catch(() => null)
        if (!slice) {
          state.failed = true
          return
        }
        state.plugins.push(...slice)
        state.loaded++
        // Re-render in batches: 44 renders of 10k cards would jank the page.
        if (state.loaded % 4 === 0) render()
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL_CHUNKS, chunks.length - 1 || 1) }, worker))
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

// Import a scan produced elsewhere (any browser, or the PowerShell one-liner).
document.addEventListener('change', (event) => {
  const input = event.target
  if (!input || input.id !== 'importFile' || !input.files?.length) return
  input.files[0].text()
    .then((text) => {
      const data = JSON.parse(text)
      const pairs = Array.isArray(data) ? Object.fromEntries(data.map((name) => [String(name), ''])) : data
      for (const [name, version] of Object.entries(pairs)) installed[name] = String(version ?? '')
      saveInstalled()
      render()
    })
    .catch((error) => alert(`导入失败：${error.message}`))
})

document.addEventListener('click', (event) => {
  if (event.target instanceof HTMLElement && event.target.tagName === 'DIALOG') { event.target.close(); return }

  const scanButton = event.target.closest('[data-scan]')
  if (scanButton) {
    scanButton.disabled = true
    scanButton.textContent = '扫描中…'
    scanInstalled()
      .then((found) => {
        if (!found) return
        Object.assign(installed, found)
        saveInstalled()
        render()
      })
      .catch((error) => alert(`扫描失败：${error.message}`))
      .finally(() => { scanButton.disabled = false; scanButton.textContent = '扫描已安装' })
    return
  }
  const importButton = event.target.closest('[data-import-input]')
  if (importButton) { document.getElementById('importFile')?.click(); return }
  const idxButton = event.target.closest('[data-idx]')
  if (idxButton) {
    for (const button of document.querySelectorAll('[data-idx]')) button.removeAttribute('aria-pressed')
    idxButton.setAttribute('aria-pressed', 'true')
    state.copyTarget = idxButton.dataset.idx
    // Picking a language source also switches the interface language: that is what
    // a reader who clicked "日本語" expects, and it keeps the copied link in sync
    // with what they are looking at.
    if (LANGS.includes(state.copyTarget)) {
      state.lang = state.copyTarget
      localStorage.setItem('dsh-market-lang', state.lang)
      chrome()
    }
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
  if (more) {
    state.limit += 120
    render()
    return
  }
  const copy = event.target.closest('[data-copy]')
  if (copy) {
    navigator.clipboard?.writeText(copy.dataset.copy).then(() => flash(copy, '已复制'))
    return
  }
  // Clicking the source row copies it (the whole row is the button).
  if (event.target.closest('.src')) {
    navigator.clipboard?.writeText(indexUrl(state.copyTarget)).then(() => flash($('copy'), '已复制'))
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
  // Switching the interface language also switches the index link, so the copied
  // URL always matches the language on screen.
  if (LANGS.includes(state.lang)) state.copyTarget = state.lang
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
  // One button per language: the subscription link is always the GitHub Pages copy.
  const seg = document.querySelector?.('.seg')
  if (seg) {
    const langs = LANGS
      .map((lang) => `<button data-idx="${lang}"${state.copyTarget === lang ? ' aria-pressed=true' : ''}>${IDX_LABEL[lang]}</button>`)
      .join('')
    seg.innerHTML = langs
  }
}

const saved = localStorage.getItem('dsh-market-lang')
if (LANGS.includes(saved)) state.lang = saved
else if (!String(navigator.language ?? '').toLowerCase().startsWith('zh')) state.lang = 'en'
chrome()
loadIndex()
// 1.2 s is enough for the dataset copy to apply; abroad it 404s immediately, so
// the fallback sheet lands before the reader notices unstyled text.
setTimeout(ensureStyles, 1200)

// Back-to-top for phones: the list runs to 10k entries once every chunk is loaded.
const toTop = document.createElement('button')
toTop.className = 'totop'
toTop.type = 'button'
toTop.textContent = '↑'
toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }))
document.body.append(toTop)
window.addEventListener('scroll', () => toTop.classList.toggle('on', window.scrollY > 700), { passive: true })
