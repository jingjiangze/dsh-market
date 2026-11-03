// Publishes the stylesheet and the bundle under a content-addressed path and
// points the shell at the jsDelivr copy of exactly that path.
//
// Why: jsDelivr caches `@main` for hours, so a plain `@main/site/style.css` URL
// kept serving an old stylesheet after a redesign (measured). A path that changes
// whenever the bytes change is a cache miss on the CDN, so the reader always gets
// the file that shipped with this commit — no purge, no TTL wait.
//
//   node crawler/assets.mjs
import { readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const site = join(root, 'site')
const assetsDir = join(site, 'a')
const CDN = 'https://cdn.jsdelivr.net/gh/jingjiangze/dsh-market@main/site'

const hash = (buffer) => createHash('sha1').update(buffer).digest('hex').slice(0, 10)

const css = await readFile(join(site, 'style.css'))
const js = await readFile(join(site, 'app.js'))
const cssHash = hash(css)
const jsHash = hash(js)

await mkdir(assetsDir, { recursive: true })
for (const [hashValue, name, buffer] of [[cssHash, 'style.css', css], [jsHash, 'app.js', js]]) {
  await mkdir(join(assetsDir, hashValue), { recursive: true })
  await writeFile(join(assetsDir, hashValue, name), buffer)
}

// Drop every other hashed directory: the repo should not accumulate dead copies.
for (const entry of await readdir(assetsDir, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name !== cssHash && entry.name !== jsHash) {
    await rm(join(assetsDir, entry.name), { recursive: true, force: true })
  }
}

const htmlPath = join(site, 'index.html')
const html = await readFile(htmlPath, 'utf8')
// Normalise first, so running this twice on an already-published file is a no-op
// instead of nesting URLs.
const relative = html
  .replace(/(<link rel=stylesheet href=)(?:[^ >]*\/)?style\.css/i, '$1/style.css')
  .replace(/(<script type=module src=)(?:[^ >]*\/)?app\.js/i, '$1/app.js')
const updated = relative
  .replace(/(<link rel=stylesheet href=)[^ >]+/i, `$1${CDN}/a/${cssHash}/style.css`)
  .replace(/(<script type=module src=)[^ >]+/i, `$1${CDN}/a/${jsHash}/app.js`)
await writeFile(htmlPath, updated)

const bytes = (await stat(htmlPath)).size
console.log(`assets: css ${cssHash} (${css.length} B), js ${jsHash} (${js.length} B), shell ${bytes} B`)
if (bytes > 1024) console.log(`assets: WARNING shell ${bytes} B exceeds the 1 KiB budget`)
