// Publishes the page's static files to the ModelScope dataset that mirrors this
// site: the hashed stylesheet/bundle and the chunked browse index.
//
// ModelScope measured 0.16-0.19 s per file with `Access-Control-Allow-Origin: *`
// and a correct Content-Type per extension, against 7.4 s for the same bytes on
// jsDelivr from this network — which is why the page now reads them from there.
//
//   MODELSCOPE_TOKEN=... node crawler/ms-upload.mjs
//   node crawler/ms-upload.mjs --dry-run     # stage only, no push
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATASET = process.env.MODELSCOPE_DATASET || 'jingjiangze/Anime-JPG'
const BRANCH = process.env.MODELSCOPE_BRANCH || 'master'
const TOKEN = process.env.MODELSCOPE_TOKEN || ''
const DRY = process.argv.includes('--dry-run')
const WORK = process.env.MODELSCOPE_WORKDIR || join(root, '..', '_tmp', 'ms-upload')
const REPO = join(WORK, 'repo')
const REMOTE = `https://www.modelscope.cn/datasets/${DATASET}.git`

const git = (args, options = {}) => execFileSync('git', args, { cwd: options.cwd ?? REPO, encoding: 'utf8', stdio: options.stdio ?? 'pipe' })
const firstLine = (error) => {
  const text = `${error.stderr ?? ''}${error.stdout ?? ''}${error.message ?? ''}`
  const line = text.split('\n').map((entry) => entry.trim()).find((entry) => entry && !entry.startsWith('at '))
  return line ?? 'unknown error'
}

// The dataset carries gigabytes of unrelated assets, so clone blobless + shallow
// and only check out the directory this project owns.
await mkdir(WORK, { recursive: true })
if (!existsSync(join(REPO, '.git'))) {
  await rm(REPO, { recursive: true, force: true })
  execFileSync('git', ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', REMOTE, REPO], { stdio: 'inherit' })
  git(['sparse-checkout', 'init', '--cone'])
  git(['sparse-checkout', 'set', 'web'])
  git(['checkout', BRANCH])
}
// Sync to the remote tip before writing anything: a shallow clone cannot rebase,
// and a stale HEAD makes the push non-fast-forward (which is what broke CI).
try {
  git(['fetch', '--depth', '1', 'origin', BRANCH])
  git(['reset', '--mixed', 'FETCH_HEAD'])
} catch (error) {
  console.log(`ms-upload: sync skipped (${firstLine(error)})`)
}

// Local files that must appear under web/ in the dataset.
const plan = []
const assetsRoot = join(root, 'site', 'a')
if (existsSync(assetsRoot)) {
  const { readdir } = await import('node:fs/promises')
  for (const hash of await readdir(assetsRoot)) {
    for (const file of await readdir(join(assetsRoot, hash))) {
      plan.push({ from: join(assetsRoot, hash, file), to: `web/a/${hash}/${file}` })
    }
  }
}
const browseRoot = join(root, 'dist', 'browse')
if (process.env.MODELSCOPE_SKIP_BROWSE !== '1' && existsSync(browseRoot)) {
  const { readdir } = await import('node:fs/promises')
  for (const file of await readdir(browseRoot)) {
    plan.push({ from: join(browseRoot, file), to: `web/browse/${file}` })
  }
}
// Mirrored icons/avatars, so the dataset also serves the artwork.
const iconsRoot = join(root, 'dist', 'icons')
if (existsSync(iconsRoot)) {
  const { readdir } = await import('node:fs/promises')
  for (const file of await readdir(iconsRoot)) {
    plan.push({ from: join(iconsRoot, file), to: `web/icons/${file}` })
  }
}
// The full format-1 documents live here too, so the dataset can be used as an
// index source on its own (and so the page can show those links).
if (process.env.MODELSCOPE_SKIP_DOCS !== '1') {
  for (const file of ['index.json', 'index.cn.json', 'index.intl.json']) {
    const from = join(root, 'site', file)
    if (existsSync(from)) plan.push({ from, to: `web/${file}` })
  }
  for (const lang of ['zh', 'en', 'ja', 'ko', 'ru']) {
    const from = join(root, 'dist', `index.${lang}.json`)
    if (existsSync(from)) plan.push({ from, to: `web/index.${lang}.json` })
  }
}
if (!plan.length) {
  console.log('ms-upload: nothing to publish')
  process.exit(0)
}

// Copy every planned file unconditionally, then let git decide what changed: a
// byte comparison here skipped files a previous (rejected) push had already left
// in the working tree, so nothing was ever committed.
for (const entry of plan) {
  // Split on "/" rather than rewriting separators: on Linux a literal backslash is a
// valid filename character, so `replace(/\//g,'\\')` silently wrote files called
// `web\browse\0.json` into the repo root, `git add web` found nothing, and the step
// reported success while publishing nothing.
const target = join(REPO, ...entry.to.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, await readFile(entry.from))
}
console.log(`ms-upload: ${plan.length} file(s) staged`)
if (DRY) process.exit(0)

try {
  git(['config', 'user.name', 'dsh-market-bot'])
  git(['config', 'user.email', 'dsh-market-bot@users.noreply.github.com'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['add', '-A', 'web'])
} catch (error) {
  console.log(`ms-upload: staging failed (${firstLine(error)})`)
  process.exit(1)
}

if (!git(['status', '--porcelain', 'web']).trim()) {
  console.log('ms-upload: dataset already up to date')
  process.exit(0)
}

let committed = false
try {
  const out = git(['commit', '-m', `publish site assets (${plan.length} file(s))`])
  committed = !/nothing to commit/i.test(out)
} catch (error) {
  const text = `${error.stdout ?? ''}${error.stderr ?? ''}`
  committed = !/nothing to commit/i.test(text)
  if (!committed) console.log(`ms-upload: commit failed (${firstLine(error)})`)
}
if (!committed) {
  console.log('ms-upload: dataset already up to date')
  process.exit(0)
}
if (!TOKEN) {
  console.log('ms-upload: MODELSCOPE_TOKEN is missing, staged but not pushed')
  process.exit(0)
}
const authRemote = REMOTE.replace('https://', `https://oauth2:${TOKEN}@`)
try {
  git(['-c', 'http.sslVerify=false', 'push', authRemote, `HEAD:${BRANCH}`])
} catch (error) {
  console.log(`ms-upload: push failed (${firstLine(error)})`)
  process.exit(1)
}
console.log(`ms-upload: pushed ${plan.length} file(s) to ${DATASET}@${BRANCH}`)
