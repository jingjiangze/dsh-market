// Real-browser verification of the published site.
//
// Everything else in this repo checks bytes: the shell budget, the index schema, the
// DOM stub in smoke-app.mjs. None of that can see a stylesheet that 404s, which is
// how a release once shipped with no CSS at all. This script drives Chromium against
// the deployed URL, asserts the computed styles that matter, and saves screenshots
// so a human can look at the same pixels.
//
// Run in CI only (needs Playwright + a browser): node crawler/visual-check.mjs [url]
import { mkdir, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const URL_TARGET = process.argv[2] || process.env.VISUAL_URL || 'https://jingjiangze.github.io/dsh-market/'
const OUT = join(root, 'dist', 'visual')

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
]

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
  })
  const page = await context.newPage()
  const failures = []
  page.on('requestfailed', (req) => failures.push(`${req.failure()?.errorText} ${req.url()}`))
  await page.goto(URL_TARGET, { waitUntil: 'networkidle', timeout: 90000 })
  // The catalogue streams in from the dataset chunks; give the first screen time.
  await page.waitForSelector('.card', { timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(1500)

  const probe = await page.evaluate(() => {
    const css = (sel, prop) => {
      const el = document.querySelector(sel)
      return el ? getComputedStyle(el).getPropertyValue(prop).trim() : null
    }
    const cards = [...document.querySelectorAll('.card')]
    const badgeCounts = cards.slice(0, 12).map((c) => (c.querySelector('.badges')?.children.length ?? 0))
    const rail = document.querySelector('.rec-row')
    return {
      bodyBg: css('body', 'background-color'),
      cssVar: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      cardCount: cards.length,
      railDisplay: rail ? getComputedStyle(rail).display : null,
      railOverflow: rail ? getComputedStyle(rail).overflowX : null,
      favPosition: css('.fav', 'position'),
      chipCount: document.querySelectorAll('#cats .chip, #cats button').length,
      gridDisplay: css('.wrap', 'display'),
      maxBadges: badgeCounts.length ? Math.max(...badgeCounts) : 0,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      deadIdxButtons: document.querySelectorAll('[data-idx="index.cn"], [data-idx="index.intl"]').length,
    }
  })

  report.push({ viewport: vp.name, ...probe, failures: failures.length })

  if (!probe.cssVar) fail(`${vp.name}: --bg is empty — the stylesheet never applied`)
  if (probe.bodyBg === 'rgba(0, 0, 0, 0)' || probe.bodyBg === 'rgb(255, 255, 255)') fail(`${vp.name}: body background is unstyled (${probe.bodyBg})`)
  if (probe.cardCount === 0) fail(`${vp.name}: no cards rendered`)
  if (probe.railDisplay !== 'flex') fail(`${vp.name}: recommendation rail display=${probe.railDisplay}, expected flex`)
  if (probe.favPosition !== 'absolute') fail(`${vp.name}: favourite button position=${probe.favPosition}, expected absolute`)
  if (probe.chipCount === 0) fail(`${vp.name}: category rail is empty`)
  if (probe.gridDisplay !== 'grid') fail(`${vp.name}: .wrap display=${probe.gridDisplay}, expected grid`)
  if (probe.maxBadges > 4) fail(`${vp.name}: a card carries ${probe.maxBadges} badges, expected <= 4`)
  if (probe.overflowX > 1) fail(`${vp.name}: page scrolls horizontally by ${probe.overflowX}px`)
  if (probe.deadIdxButtons > 0) fail(`${vp.name}: dead region-toggle buttons are still in the DOM`)

  await page.screenshot({ path: join(OUT, `${vp.name}-top.png`) })
  await page.screenshot({ path: join(OUT, `${vp.name}-full.png`), fullPage: true })
  // One detail dialog, which is the densest layout.
  const firstCard = await page.$('.card')
  if (firstCard) {
    await firstCard.click()
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(OUT, `${vp.name}-detail.png`) })
  }
  await context.close()
}

await browser.close()
await writeFile(join(OUT, 'report.json'), JSON.stringify({ url: URL_TARGET, report, problems }, null, 2) + '\n')
console.log(JSON.stringify({ url: URL_TARGET, report, problems }, null, 2))
if (problems.length) {
  console.error(`visual: FAIL ${problems.length} problem(s)`)
  process.exit(1)
}
console.log(`visual: PASS (${report.length} viewports, screenshots in dist/visual)`)
