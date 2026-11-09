// Real-browser verification of the site's layout and styling.
//
// Bytes cannot see a stylesheet that 404s, which is how a release once shipped with
// no CSS at all while every offline check stayed green. This script renders the real
// shell in Chromium, asserts the computed styles that matter, and saves screenshots.
//
// It runs against a LOCAL fixture (site/ served over http, browse data stubbed) so the
// result is deterministic and independent of CDN reachability from the runner. Use
// `--live` to additionally probe the deployed asset URLs over the network.
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile, readdir, stat } from 'node:fs/promises'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = join(root, 'site')
const OUT = join(root, 'dist', 'visual')
const LIVE = process.argv.includes('--live')
const LIVE_URL = process.env.VISUAL_URL || 'https://jingjiangze.github.io/dsh-market/'

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
]

// A fixture large enough to exercise the grid, the counts and the daily rail.
const FIXTURE = Array.from({ length: 48 }, (_, i) => ({
  n: `dsh-fixture-${i}`,
  t: `示例插件 ${i}`,
  e: `Fixture plugin ${i}`,
  d: '用于视觉校验的示例描述，长度足够换行以检验两行截断。',
  de: 'Fixture description long enough to wrap and exercise the two line clamp.',
  c: ['enhance-ui', 'enhance-tools', 'agent-orchestration', 'data-office', 'connect-im', 'media-vision'][i % 6],
  v: `1.${i % 9}.0`,
  p: 1790000000 + i * 3600,
  s: 100 + i * 37,
  dl: 10 + i * 11,
  l: ['src-official', i % 4 === 0 ? 'catalog-only' : 'src-npm'],
  // Practical score + use-case ids, so the score badge and the quiz are exercised.
  // Distinct, non-monotonic popularity so the heat and stars orders genuinely differ.
  sc: 30 + ((i * 7) % 70),
  // Curation fields the page renders: a mark on official picks.
  of: i < 8 ? 1 : 0,
  cu: 40 + ((i * 11) % 60),
  s: 100 + ((i * 13) % 900),
  dl: 50 + ((i * 29) % 400),
  // A real thumbnail so the `.hicon` path is exercised, not just the .dot fallback.
  i: 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 8 8%27%3E%3Crect width=%278%27 height=%278%27 fill=%27%234d6bfe%27/%3E%3C/svg%3E',
  u: [['finance', 'ui'], ['agents', 'automation'], ['knowledge', 'docs'], ['image', 'voice']][i % 4],
  // Three neighbours each, so the detail dialog renders the similar rail.
  sim: [0, 1, 2].map((offset) => `dsh-fixture-${(i + offset + 1) % 48}`),
}))

const META = {
  total: FIXTURE.length,
  updatedAt: new Date().toISOString(),
  chunks: ['0.json'],
  categories: {
    'enhance-ui': { title: { en: 'Interface & themes', zh: '界面与主题' } },
    'enhance-tools': { title: { en: 'Tools & CLI', zh: '工具链与 CLI' } },
    'agent-orchestration': { title: { en: 'Agents & orchestration', zh: '智能体与编排' } },
    'data-office': { title: { en: 'Office & content', zh: '办公与创作' } },
    'connect-im': { title: { en: 'Chat & notifications', zh: '即时通讯与通知' } },
    'media-vision': { title: { en: 'Vision & images', zh: '视觉与图像' } },
  },
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' }

// Serve site/ plus the stubbed browse data, and rewrite the shell's absolute mirror
// URLs to same-origin paths so the render never touches the network.
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/browse/meta.json') {
      res.writeHead(200, { 'content-type': TYPES['.json'] })
      return res.end(JSON.stringify(META))
    }
    if (url.pathname === '/browse/0.json') {
      res.writeHead(200, { 'content-type': TYPES['.json'] })
      return res.end(JSON.stringify(FIXTURE))
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    const file = join(SITE, rel)
    if (!file.startsWith(SITE)) { res.writeHead(403); return res.end() }
    let body = await readFile(file)
    if (rel === 'index.html') {
      body = Buffer.from(String(body)
        .replace(/https:\/\/modelscope\.cn\/datasets\/jingjiangze\/Anime-JPG\/resolve\/master\/web/g, '')
        .replace(/https:\/\/jingjiangze\.github\.io\/dsh-market/g, ''))
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/`

const problems = []
const fail = (msg) => problems.push(msg)
await mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
const report = []
for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    isMobile: Boolean(vp.isMobile),
    hasTouch: Boolean(vp.hasTouch),
    deviceScaleFactor: vp.deviceScaleFactor ?? 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  })
  const page = await context.newPage()
  const failedAssets = []
  const hits = []
  const consoleErrors = []
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200)) })
  page.on('requestfailed', (req) => {
    if (/\.(css|js)(\?|$)/.test(req.url())) failedAssets.push(`${req.failure()?.errorText} ${req.url()}`)
  })
  // app.js hardcodes absolute mirror URLs for its data and its own bundle, so the
  // fixture has to answer those origins too. Routing keeps the render fully offline
  // and deterministic: no CDN, no dataset, no dependence on the runner's network.
  //
  // One handler, dispatched by URL: two overlapping routes are resolved by Playwright
  // in reverse registration order, so a broad `/browse/*.json` rule silently answered
  // `meta.json` with the chunk array. meta stayed an array, `chunks` was undefined and
  // the render bailed before painting a single card.
  await context.route(/\/browse\/[^/]+\.json(\?.*)?$/, (route) => {
    const url = route.request().url()
    const isMeta = /\/browse\/meta\.json(\?|$)/.test(url)
    hits.push(`${isMeta ? 'meta' : 'chunk'} ${url}`)
    return route.fulfill({ json: isMeta ? META : FIXTURE })
  })
  await context.route(/\/a\/[0-9a-f]{10}\/style\.css(\?.*)?$/, async (route) => {
    route.fulfill({ body: await readFile(join(SITE, 'style.css')), contentType: TYPES['.css'] })
  })
  await context.route(/\/a\/[0-9a-f]{10}\/app\.js(\?.*)?$/, async (route) => {
    route.fulfill({ body: await readFile(join(SITE, 'app.js')), contentType: TYPES['.js'] })
  })
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('.card', { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(1200)

  const probe = await page.evaluate(() => {
    const css = (sel, prop) => {
      const el = document.querySelector(sel)
      return el ? getComputedStyle(el).getPropertyValue(prop).trim() : null
    }
    const cards = [...document.querySelectorAll('.card')]
    const badgeCounts = cards.slice(0, 16).map((c) => (c.querySelector('.badges')?.children.length ?? 0))
    const rail = document.querySelector('.rec-row')
    return {
      cssVar: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      bodyBg: css('body', 'background-color'),
      cardCount: cards.length,
      railDisplay: rail ? getComputedStyle(rail).display : null,
      favPosition: css('.fav', 'position'),
      chipCount: document.querySelectorAll('#cats button').length,
      gridDisplay: css('.wrap', 'display'),
      maxBadges: badgeCounts.length ? Math.max(...badgeCounts) : 0,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      deadIdxButtons: document.querySelectorAll('[data-idx="index.cn"], [data-idx="index.intl"]').length,
      shelves: document.querySelectorAll('.rec-shelf').length,
      // Heat was removed by request; the gate now enforces its absence instead of its presence.
      heatBadges: [...document.querySelectorAll('.card .meta span')].filter((el) => el.textContent.trim().startsWith('🔥')).length,
      themeToggle: Boolean(document.querySelector('#theme')),
      theme: document.documentElement.dataset.theme ?? null,
      // The shelf was removed: 精选推荐 is an ordering, not a fixed five-item block.
      pickMarks: document.querySelectorAll('.card .pick').length,
      // Usability invariants: the subscription block is folded away by default, search owns a
      // full row, and the trend windows live behind one menu.
      // Where the first card starts is the blunt usability metric: chrome that pushes it down
      // is chrome the reader has to scroll past every visit.
      // A card must announce that it opens something, and the install row must explain itself
      // when nothing is installed.
      // The subscription link and its fallback: the site tries three hosts for data, so the
      // link a reader copies should name a host that exists and offer the other one.
      // The summary a reader actually reads. A field that arrives as an array of score figures
      // must never reach this paragraph.
      indexSource: document.querySelector("#src")?.textContent?.trim() ?? null,
      indexAlternate: document.querySelector("#srcalt")?.dataset?.copy ?? null,
      cardRole: document.querySelector('.card')?.getAttribute('role') ?? null,
      cardChevron: document.querySelectorAll('.card .go').length,
      installHint: Boolean(document.querySelector('.ins-hint')),
      installImportFolded: (() => { const d = document.querySelector('.ins-more'); return d ? !d.open : null })(),
      firstCardTop: (() => {
        const card = document.querySelector('.card')
        return card ? Math.round(card.getBoundingClientRect().top) : null
      })(),
      overflowClosed: (() => { const d = document.querySelector("#overflow"); return d ? !d.open : null })(),
      setupClosed: (() => { const d = document.querySelector('.setup'); return d ? !d.open : null })(),
      setupInFirstScreen: (() => { const d = document.querySelector('.setup'); return d ? d.getBoundingClientRect().top < 400 : null })(),
      searchWidthRatio: (() => {
        const q = document.querySelector('#q')
        if (!q) return 0
        return Math.round((q.getBoundingClientRect().width / document.documentElement.clientWidth) * 100)
      })(),
      primarySorts: [...document.querySelectorAll('#sort > .sorts [data-sort]')].length,
      trendSortsInMenu: document.querySelectorAll('.more-sorts [data-sort]').length,
      curatedSortLabel: [...document.querySelectorAll('[data-sort]')].map((b) => b.textContent.trim()).find((t) => t.includes('精选')) ?? null,
      pickMarks: document.querySelectorAll('.card .pick').length,
      thumbWidths: [...document.querySelectorAll('.card img')].slice(0, 8).map((el) => Math.round(el.getBoundingClientRect().width)),
      imgThumbs: document.querySelectorAll('.card img').length,
      quizButton: Boolean(document.querySelector('[data-quiz]')),
      mirrorSelect: document.querySelector('#mirror')?.value ?? null,
      scoreSort: Boolean(document.querySelector('[data-sort="curated"]')),
      emptyMeta: (document.getElementById('meta')?.textContent ?? '').includes('加载中'),
      metaText: (document.getElementById('meta')?.textContent ?? '').slice(0, 80),
      listText: (document.getElementById('list')?.textContent ?? '').slice(0, 120),
    }
  })
  report.push({ viewport: vp.name, ...probe, hits, consoleErrors })

  if (!probe.cssVar) fail(`${vp.name}: --bg empty — the stylesheet never applied`)
  if (probe.bodyBg === 'rgba(0, 0, 0, 0)') fail(`${vp.name}: body background unstyled`)
  if (probe.cardCount === 0) fail(`${vp.name}: no cards rendered`)
  // The recommendation shelves were retired, so `.rec-row` only exists inside the
  // quiz and similar strips — there is no rail to assert on first paint.
  if (probe.favPosition !== 'absolute') fail(`${vp.name}: favourite position=${probe.favPosition}, expected absolute`)
  if (probe.chipCount === 0) fail(`${vp.name}: category rail empty`)
  if (probe.gridDisplay !== 'grid') fail(`${vp.name}: .wrap display=${probe.gridDisplay}, expected grid`)
  if (probe.maxBadges > 4) fail(`${vp.name}: a card carries ${probe.maxBadges} badges, expected <= 4`)
  if (probe.overflowX > 1) fail(`${vp.name}: horizontal scroll by ${probe.overflowX}px`)
  if (probe.deadIdxButtons) fail(`${vp.name}: dead region-toggle buttons present`)
  if (probe.shelves > 0) fail(`${vp.name}: a retired recommendation shelf is still rendered`)
  if (probe.heatBadges !== 0) fail(`${vp.name}: ${probe.heatBadges} card(s) still show a heat badge`)
  if (!probe.themeToggle) fail(`${vp.name}: the theme toggle is missing`)
  if (!probe.theme) fail(`${vp.name}: no data-theme on <html>`)
  if (probe.pickMarks === 0) fail(`${vp.name}: no card carries the 官方精选 badge`)
  if (probe.curatedSortLabel !== '精选推荐') fail(`${vp.name}: the curated ranking is labelled "${probe.curatedSortLabel}", expected 精选推荐`)
  if (await page.locator('.picks').count()) fail(`${vp.name}: the removed curated shelf is still rendered`)
  if (probe.setupClosed !== true) fail(`${vp.name}: the subscription block is not collapsed by default`)
  // The subscription block moved into the overflow menu; what matters now is that the menu
  // exists and starts closed, so the toolbar stays one row.
  if (probe.overflowClosed !== true) fail(`${vp.name}: the overflow menu is not collapsed by default`)
  // Search must own most of a row: it is the primary way into a 13k catalogue.
  if (probe.searchWidthRatio < 60) fail(`${vp.name}: the search field is only ${probe.searchWidthRatio}% of the viewport wide`)
  if (probe.primarySorts === 0 || probe.primarySorts > 6) fail(`${vp.name}: ${probe.primarySorts} sort buttons visible, expected 4-6`)
  if (probe.trendSortsInMenu !== 3) fail(`${vp.name}: ${probe.trendSortsInMenu} trend sorts in the menu, expected 3`)
  // Mobile had four wrapped control rows; the limit keeps a regression from creeping back.
  const cardTopLimit = vp.name === 'mobile' ? 760 : 520
  if (probe.firstCardTop === null) fail(`${vp.name}: no card was rendered`)
  else if (probe.firstCardTop > cardTopLimit) fail(`${vp.name}: the first card starts at ${probe.firstCardTop}px, limit ${cardTopLimit}px`)
  if (!/^https:\/\/(jingjiangze\.github\.io\/dsh-market|dsh\.jiangjiangze\.icu)\/index\.(zh|en|ja|ko|ru)\.json$/.test(probe.indexSource ?? '')) fail(`${vp.name}: the subscription link is "${probe.indexSource}", not a known host`)
  if (!probe.indexAlternate) fail(`${vp.name}: no fallback subscription source is offered`)
  if (probe.cardRole !== 'button') fail(`${vp.name}: cards do not expose role=button (got ${probe.cardRole})`)
  if (probe.cardChevron !== probe.cardCount) fail(`${vp.name}: ${probe.cardChevron} chevrons for ${probe.cardCount} cards`)
  if (!probe.installHint) fail(`${vp.name}: the install row does not explain itself when nothing is installed`)
  if (probe.installImportFolded !== true) fail(`${vp.name}: the JSON import is not folded behind a disclosure`)
  // An unconstrained <img> is what broke the card layout once: icons stretched to the
  // card width and the description wrapped one character per line.
  if (probe.imgThumbs === 0) fail(`${vp.name}: the fixture rendered no card thumbnails`)
  const fat = probe.thumbWidths.filter((width) => width > 64)
  if (fat.length) fail(`${vp.name}: card thumbnail width ${fat[0]}px, expected <= 64px`)
  if (!probe.quizButton) fail(`${vp.name}: the quiz entry point is missing`)
  if (!probe.mirrorSelect) fail(`${vp.name}: the install-mirror picker is missing`)
  if (!probe.scoreSort) fail(`${vp.name}: the curated sort is missing`)
  if (probe.emptyMeta) fail(`${vp.name}: #meta still says 加载中 — the catalogue never rendered`)
  for (const asset of failedAssets) fail(`${vp.name}: asset failed — ${asset}`)

  await page.screenshot({ path: join(OUT, `${vp.name}-top.png`) })
  await page.screenshot({ path: join(OUT, `${vp.name}-full.png`), fullPage: true })
  if (vp.name === 'desktop') {
    await page.evaluate(() => { const m = document.querySelector('#overflow'); if (m) m.open = true })
    await page.waitForTimeout(120)
    await page.click('[data-quiz]')
    await page.waitForTimeout(400)
    const chips = await page.locator('.quiz-chip').count()
    if (chips < 10) fail('desktop: the quiz shows no use-case chips')
    await page.locator('.quiz-chip').first().click()
    await page.waitForTimeout(400)
    const results = await page.locator('#quizResults .rec-item').count()
    if (results === 0) fail('desktop: the quiz returned no results for a picked use case')
    await page.screenshot({ path: join(OUT, 'desktop-quiz.png') })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
  const firstCard = await page.$('.card')
  if (firstCard) {
    await firstCard.click()
    await page.waitForTimeout(700)
    await page.screenshot({ path: join(OUT, `${vp.name}-detail.png`) })
    // The heat button used to fall through to the stars key, so both produced the same
    // list. Compare the first names under each sort. The clicks go through the DOM:
    // the quiz dialog is modal, so a pointer click on the toolbar waits forever.
    await page.evaluate(() => { const d = document.getElementById("dlg"); if (d && d.open) d.close() })
    const orderUnder = async (mode) => {
      await page.evaluate((sort) => document.querySelector('[data-sort="' + sort + '"]')?.click(), mode)
      await page.waitForTimeout(300)
      return page.$$eval(".card h2", (nodes) => nodes.slice(0, 6).map((n) => n.textContent.trim()))
    }
    const starsOrder = await orderUnder("stars")
    const heatOrder = await orderUnder("curated")
    if (!starsOrder.length || !heatOrder.length) fail("desktop: no cards rendered after switching sort")
    else if (starsOrder.join() === heatOrder.join()) fail("desktop: 热度 and 星标 produce the identical order")
    // Reopen a card so the detail probes below have a dialog to read.
    // Capture-phase listener, installed before the click: proves whether the event reaches
    // the document at all, which separates "the handler is broken" from "nothing was clicked".
    await page.evaluate(() => {
      window.__probe = { clicks: 0, target: null, closestOpen: null }
      document.addEventListener('click', (e) => {
        window.__probe.clicks += 1
        window.__probe.target = `${e.target.tagName}.${String(e.target.className || '')}`.slice(0, 60)
        window.__probe.closestOpen = e.target.closest?.('[data-open]')?.dataset?.open ?? null
      }, true)
    })
    await page.evaluate(() => document.querySelector(".card")?.click())
    await page.waitForTimeout(400)
  // Diagnostic: when the dialog looks empty, the useful facts are whether it opened at all
  // and how much markup it holds.
  const dialogDiag = await page.evaluate(() => {
    const d = document.getElementById('dlg')
    return {
      open: Boolean(d && d.open),
      htmlLength: d ? d.innerHTML.length : -1,
      hasLead: Boolean(d && d.querySelector('.lead')),
      leadText: d?.querySelector('.lead')?.textContent?.trim() ?? null,
      hasDl: Boolean(d && d.querySelector('dl')),
      hasSim: Boolean(d && d.querySelector('.sim')),
      cards: document.querySelectorAll('.card').length,
      openAttr: document.querySelector('.card')?.dataset?.open ?? null,
      clickProbe: window.__probe ?? null,
      openTrace: window.__openTrace ?? null,
      dlgHead: document.getElementById('dlg')?.innerHTML.slice(0, 100) ?? null,
    }
  })
  report.push({ viewport: 'dialog-diag', ...dialogDiag })
  if (!dialogDiag.open) fail('desktop: the detail dialog never opened after a card click')
  else if (!dialogDiag.hasLead) fail(`desktop: the dialog opened but has no summary (markup ${dialogDiag.htmlLength} chars)`)
  else if (/^[★☆↓↑🔒⭐]/.test(dialogDiag.leadText ?? '') || ((dialogDiag.leadText ?? '').match(/[★☆↓↑🔒⭐]/g) ?? []).length >= 2) fail(`desktop: the detail description is a figure dump: ${String(dialogDiag.leadText).slice(0, 60)}`)
  else if ((dialogDiag.leadText ?? '').length < 12) fail(`desktop: the detail description is only ${String(dialogDiag.leadText).length} characters`)

  const detailGrid = await page.evaluate(() => {
    const dl = document.querySelector('#dlg dl')
    if (!dl) return null
    const labels = [...dl.querySelectorAll('dt')].map((n) => n.textContent.trim())
    return { display: getComputedStyle(dl).display, columns: getComputedStyle(dl).gridTemplateColumns, hasHeat: labels.includes('热度') }
  })
  if (!detailGrid) fail('desktop: the detail dialog rendered no definition list')
  else {
    if (detailGrid.display !== 'grid') fail(`desktop: detail list display=${detailGrid.display}, expected grid`)
    if (detailGrid.hasHeat) fail('desktop: the detail dialog still shows a heat row')
    const sections = await page.evaluate(() => ({
      facts: Boolean(document.querySelector('#dlg .facts dl')),
      install: Boolean(document.querySelector('#dlg .install .cmd')),
    }))
    if (!sections.facts) fail('desktop: the detail dialog has no facts section')
    if (!sections.install) fail('desktop: the detail dialog has no install section')
    const cmd = await page.evaluate(() => document.querySelector('#dlg .cmd code')?.textContent ?? '')
    if (!/--registry=/.test(cmd)) fail(`desktop: the install command names no registry (got “${cmd}”)`)
  }
  const simCount = await page.locator('.sim .rec-item').count()
    if (simCount === 0) fail(`${vp.name}: the detail dialog shows no similar plugins`)
  }
  if (!problems.length) {
    // The page follows prefers-color-scheme on a first visit, and Playwright reports light
    // by default, so the assertion must not assume which theme is showing — only that the
    // toggle flips it, flips it back, and that each theme paints the right kind of surface.
    const themes = await page.evaluate(async () => {
      const read = () => ({
        theme: document.documentElement.dataset.theme ?? null,
        bg: getComputedStyle(document.body).backgroundColor,
      })
      const button = document.querySelector('#theme')
      if (!button) return null
      const first = read()
      button.click()
      await new Promise((resolve) => setTimeout(resolve, 160))
      const second = read()
      button.click()
      await new Promise((resolve) => setTimeout(resolve, 160))
      const third = read()
      return { first, second, third }
    })
    if (!themes) fail('desktop: the theme toggle disappeared')
    else {
      const { first, second, third } = themes
      if (second.theme === first.theme) fail(`desktop: the theme toggle did not change the theme (stayed ${first.theme})`)
      if (third.theme !== first.theme) fail(`desktop: the theme toggle did not switch back (now ${third.theme})`)
      const luminance = (color) => {
        const parts = String(color).match(/\d+/g) ?? []
        if (parts.length < 3) return null
        return 0.299 * Number(parts[0]) + 0.587 * Number(parts[1]) + 0.114 * Number(parts[2])
      }
      const l1 = luminance(first.bg)
      const l2 = luminance(second.bg)
      if (l1 === null || l2 === null) fail(`desktop: unreadable background colour (${first.bg} / ${second.bg})`)
      else if (Math.abs(l1 - l2) < 40) fail(`desktop: both themes painted the same surface (${first.bg} vs ${second.bg})`)
      else if (first.theme === 'light' && l1 < 200) fail(`desktop: light theme background is not light (${first.bg})`)
      else if (second.theme === 'light' && l2 < 200) fail(`desktop: light theme background is not light (${second.bg})`)
    }
  }
  await context.close()
}
await browser.close()
server.close()

// Optional network probe of the deployed shell's asset URLs.
const live = []
if (LIVE) {
  const shell = await fetch(LIVE_URL, { redirect: 'follow' }).then((r) => r.text())
  const hash = (shell.match(/a\/([0-9a-f]{10})\//) ?? [])[1]
  live.push({ url: LIVE_URL, hash: hash ?? null, shellBytes: Buffer.byteLength(shell, 'utf8') })
  if (!hash) fail('live: the shell references no hashed bundle')
  else {
    for (const file of ['style.css', 'app.js']) {
      const probeUrl = `https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/web/a/${hash}/${file}`
      const res = await fetch(probeUrl).catch(() => null)
      live.push({ asset: file, status: res?.status ?? 0 })
      if (!res || res.status !== 200) fail(`live: dataset ${file} for ${hash} returned ${res?.status ?? 'error'}`)
    }
  }
}

await writeFile(join(OUT, 'report.json'), JSON.stringify({ base, report, live, problems }, null, 2) + '\n')
console.log(JSON.stringify({ report, live, problems }, null, 2))
if (problems.length) {
  console.error(`visual: FAIL ${problems.length} problem(s)`)
  process.exit(1)
}
console.log(`visual: PASS (${report.length} viewports, screenshots in dist/visual)`)
