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
      heatBadges: [...document.querySelectorAll('.card .meta span')].filter((el) => el.textContent.trim().startsWith('🔥')).length,
      thumbWidths: [...document.querySelectorAll('.card img')].slice(0, 8).map((el) => Math.round(el.getBoundingClientRect().width)),
      imgThumbs: document.querySelectorAll('.card img').length,
      quizButton: Boolean(document.querySelector('[data-quiz]')),
      mirrorSelect: document.querySelector('#mirror')?.value ?? null,
      scoreSort: Boolean(document.querySelector('[data-sort="score"]')),
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
  if (probe.heatBadges === 0) fail(`${vp.name}: no card shows a heat badge`)
  // An unconstrained <img> is what broke the card layout once: icons stretched to the
  // card width and the description wrapped one character per line.
  if (probe.imgThumbs === 0) fail(`${vp.name}: the fixture rendered no card thumbnails`)
  const fat = probe.thumbWidths.filter((width) => width > 64)
  if (fat.length) fail(`${vp.name}: card thumbnail width ${fat[0]}px, expected <= 64px`)
  if (!probe.quizButton) fail(`${vp.name}: the quiz entry point is missing`)
  if (!probe.mirrorSelect) fail(`${vp.name}: the install-mirror picker is missing`)
  if (!probe.scoreSort) fail(`${vp.name}: the heat sort is missing`)
  if (probe.emptyMeta) fail(`${vp.name}: #meta still says 加载中 — the catalogue never rendered`)
  for (const asset of failedAssets) fail(`${vp.name}: asset failed — ${asset}`)

  await page.screenshot({ path: join(OUT, `${vp.name}-top.png`) })
  await page.screenshot({ path: join(OUT, `${vp.name}-full.png`), fullPage: true })
  if (vp.name === 'desktop') {
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
    const heatOrder = await orderUnder("score")
    if (!starsOrder.length || !heatOrder.length) fail("desktop: no cards rendered after switching sort")
    else if (starsOrder.join() === heatOrder.join()) fail("desktop: 热度 and 星标 produce the identical order")
    // Reopen a card so the detail probes below have a dialog to read.
    await page.evaluate(() => document.querySelector(".card")?.click())
    await page.waitForTimeout(400)
  const detailGrid = await page.evaluate(() => {
    const dl = document.querySelector('#dlg dl')
    if (!dl) return null
    const labels = [...dl.querySelectorAll('dt')].map((n) => n.textContent.trim())
    return { display: getComputedStyle(dl).display, columns: getComputedStyle(dl).gridTemplateColumns, hasHeat: labels.includes('热度') }
  })
  if (!detailGrid) fail('desktop: the detail dialog rendered no definition list')
  else {
    if (detailGrid.display !== 'grid') fail(`desktop: detail list display=${detailGrid.display}, expected grid`)
    if (!detailGrid.hasHeat) fail('desktop: the detail dialog does not show a heat row')
    const cmd = await page.evaluate(() => document.querySelector('#dlg .cmd code')?.textContent ?? '')
    if (!/--registry=/.test(cmd)) fail(`desktop: the install command names no registry (got “${cmd}”)`)
  }
  const simCount = await page.locator('.sim .rec-item').count()
    if (simCount === 0) fail(`${vp.name}: the detail dialog shows no similar plugins`)
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
