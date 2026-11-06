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
  page.on('requestfailed', (req) => {
    if (/\.(css|js)(\?|$)/.test(req.url())) failedAssets.push(`${req.failure()?.errorText} ${req.url()}`)
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
      emptyMeta: (document.getElementById('meta')?.textContent ?? '').includes('加载中'),
    }
  })
  report.push({ viewport: vp.name, ...probe })

  if (!probe.cssVar) fail(`${vp.name}: --bg empty — the stylesheet never applied`)
  if (probe.bodyBg === 'rgba(0, 0, 0, 0)') fail(`${vp.name}: body background unstyled`)
  if (probe.cardCount === 0) fail(`${vp.name}: no cards rendered`)
  if (probe.railDisplay !== 'flex') fail(`${vp.name}: rail display=${probe.railDisplay}, expected flex`)
  if (probe.favPosition !== 'absolute') fail(`${vp.name}: favourite position=${probe.favPosition}, expected absolute`)
  if (probe.chipCount === 0) fail(`${vp.name}: category rail empty`)
  if (probe.gridDisplay !== 'grid') fail(`${vp.name}: .wrap display=${probe.gridDisplay}, expected grid`)
  if (probe.maxBadges > 4) fail(`${vp.name}: a card carries ${probe.maxBadges} badges, expected <= 4`)
  if (probe.overflowX > 1) fail(`${vp.name}: horizontal scroll by ${probe.overflowX}px`)
  if (probe.deadIdxButtons) fail(`${vp.name}: dead region-toggle buttons present`)
  if (probe.emptyMeta) fail(`${vp.name}: #meta still says 加载中 — the catalogue never rendered`)
  for (const asset of failedAssets) fail(`${vp.name}: asset failed — ${asset}`)

  await page.screenshot({ path: join(OUT, `${vp.name}-top.png`) })
  await page.screenshot({ path: join(OUT, `${vp.name}-full.png`), fullPage: true })
  const firstCard = await page.$('.card')
  if (firstCard) {
    await firstCard.click()
    await page.waitForTimeout(700)
    await page.screenshot({ path: join(OUT, `${vp.name}-detail.png`) })
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
