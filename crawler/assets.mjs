// Publishes the stylesheet and the bundle under ONE content-addressed directory and
// rewrites the shell's three mirror tiers to point at it.
//
// Why a combined hash: the shell carries a single `<script>` loader over three tiers,
// so both files must share a directory name — one hash over (css + js) gives that.
// Why a hashed path at all: every CDN caches `@main` for hours, and a path that
// changes with the bytes is a guaranteed cache miss, so a redesign is immediate.
//
//   node crawler/assets.mjs
import { readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const site = join(root, 'site')
const assetsDir = join(site, 'a')
// Tier 1 is the ModelScope dataset (0.16-0.19 s measured, CORS *, right MIME),
// tier 2 the jsDelivr mirror, tier 3 this site's own copy.
const TIERS = [
  (process.env.ASSET_TIER1 || 'https://modelscope.cn/datasets/jingjiangze/Anime-JPG/resolve/master/web/a'),
  (process.env.ASSET_TIER2 || 'https://cdn.jsdelivr.net/gh/jingjiangze/dsh-market@main/site/a'),
  (process.env.ASSET_TIER3 || '/a'),
]

const css = await readFile(join(site, 'style.css'))
const js = await readFile(join(site, 'app.js'))
const version = createHash('sha1').update(css).update(js).digest('hex').slice(0, 10)

await mkdir(join(assetsDir, version), { recursive: true })
await writeFile(join(assetsDir, version, 'style.css'), css)
await writeFile(join(assetsDir, version, 'app.js'), js)

// Drop every other hashed directory: the repo should not accumulate dead copies.
for (const entry of await readdir(assetsDir, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name !== version) {
    await rm(join(assetsDir, entry.name), { recursive: true, force: true })
  }
}

const htmlPath = join(site, 'index.html')
// Normalise back to the plain relative references first, so this stays idempotent.
const authored = (await readFile(htmlPath, 'utf8'))
  .replace(/(<link rel=stylesheet href=)[^>]*>/i, '$1/style.css>')
  .replace(/(<script type=module src=)[^>]*>/i, '$1/app.js>')
// Tier 1 (the dataset) is what the shell points at; the bundle carries an
// `onerror` hop to this site's own copy, and `ensureStyles` in the bundle walks
// the rest of the tiers for the stylesheet.
const updated = authored
  .replace(/(<link rel=stylesheet href=)[^>]*>/i, `$1${TIERS[0]}/${version}/style.css>`)
  .replace(/(<script type=module src=)[^>]*>/i, `$1${TIERS[0]}/${version}/app.js onerror="this.src='/app.js'">`)
await writeFile(htmlPath, updated)

const bytes = (await stat(htmlPath)).size
console.log(`assets: version ${version} (css ${css.length} B, js ${js.length} B), shell ${bytes} B`)
if (bytes > 1024) console.log(`assets: WARNING shell ${bytes} B exceeds the 1 KiB budget`)
