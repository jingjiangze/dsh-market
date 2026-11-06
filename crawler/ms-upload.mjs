// Publishes the page's static files to the ModelScope dataset that mirrors this
// site: the hashed stylesheet/bundle, the chunked browse index, the mirrored icons
// and the per-language index documents.
//
// ModelScope measured 0.16-0.23 s per file with `Access-Control-Allow-Origin: *`
// and a correct Content-Type per extension, against 7.4 s for the same bytes on
// jsDelivr from this network — which is why the page reads them from there.
//
//   MODELSCOPE_TOKEN=... node crawler/ms-upload.mjs
//   node crawler/ms-upload.mjs --dry-run     # report, change nothing
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
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
const LANGS = ['zh', 'en', 'ja', 'ko', 'ru']

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

// ---- what this run owns -------------------------------------------------------
const plan = []
const add = (from, to) => plan.push({ from, to })

const assetsRoot = join(root, 'site', 'a')
if (existsSync(assetsRoot)) {
  for (const hash of await readdir(assetsRoot)) {
    for (const file of await readdir(join(assetsRoot, hash))) {
      add(join(assetsRoot, hash, file), `web/a/${hash}/${file}`)
    }
  }
}
if (process.env.MODELSCOPE_SKIP_BROWSE !== '1' && existsSync(join(root, 'dist', 'browse'))) {
  for (const file of await readdir(join(root, 'dist', 'browse'))) {
    add(join(root, 'dist', 'browse', file), `web/browse/${file}`)
  }
}
if (existsSync(join(root, 'dist', 'icons'))) {
  for (const file of await readdir(join(root, 'dist', 'icons'))) {
    add(join(root, 'dist', 'icons', file), `web/icons/${file}`)
  }
}
if (process.env.MODELSCOPE_SKIP_DOCS !== '1') {
  for (const file of ['index.json', 'index.cn.json', 'index.intl.json']) {
    const from = join(root, 'site', file)
    if (existsSync(from)) add(from, `web/${file}`)
  }
  for (const lang of LANGS) {
    const from = join(root, 'dist', `index.${lang}.json`)
    if (existsSync(from)) add(from, `web/index.${lang}.json`)
  }
}

if (!plan.length) {
  console.log('ms-upload: nothing to publish')
  process.exit(0)
}
console.log(`ms-upload: ${plan.length} file(s) planned`)
if (DRY) process.exit(0)

// Only the paths this run owns are staged. A blanket `git add -A web` also stages
// the *absence* of files missing from this (possibly partial) working tree, which
// silently deleted another run's mirrored icons.
//
// `web/a` is a directory of per-hash bundles that accumulate across runs, so the
// owned scope must be `web/a/<hash>` and never `web/a`: with the whole parent,
// `git add -A web/a` treated every other bundle as deleted, and a bundle that a
// published shell still pointed at vanished from the dataset — the stylesheet
// 404'd and the site rendered with no CSS at all.
const owned = [...new Set(plan.map((entry) => {
  const parts = entry.to.split('/')
  return parts[0] === 'web' && parts[1] === 'a' && parts[2] ? `web/a/${parts[2]}` : parts.slice(0, 2).join('/')
}))]
const authRemote = TOKEN ? REMOTE.replace('https://', `https://oauth2:${TOKEN}@`) : null

// Publish with retries: the crawl and the translate job both push to this branch,
// so an attempt can lose the race and must re-sync, re-stage and commit again.
async function publishOnce(attempt) {
  try {
    git(['fetch', '--depth', '1', 'origin', BRANCH])
    git(['reset', '--mixed', 'FETCH_HEAD'])
  } catch (error) {
    console.log(`ms-upload: sync failed (${firstLine(error)})`)
    return false
  }
  for (const entry of plan) {
    // Split on "/" rather than rewriting separators: on Linux a literal backslash is
    // a valid filename character, so `replace(/\//g,'\\')` wrote files named
    // `web\browse\0.json` into the repo root and published nothing.
    const target = join(REPO, ...entry.to.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, await readFile(entry.from))
  }
  git(['config', 'user.name', 'dsh-market-bot'])
  git(['config', 'user.email', 'dsh-market-bot@users.noreply.github.com'])
  git(['config', 'commit.gpgsign', 'false'])
  for (const path of owned) git(['add', '-A', '--', path])
  if (!git(['status', '--porcelain', ...owned]).trim()) {
    console.log('ms-upload: dataset already up to date')
    return true
  }
  try {
    git(['commit', '-m', `publish web assets (${plan.length} files, attempt ${attempt})`])
  } catch (error) {
    if (/nothing to commit/i.test(`${error.stdout ?? ''}${error.stderr ?? ''}`)) {
      console.log('ms-upload: dataset already up to date')
      return true
    }
    console.log(`ms-upload: commit failed (${firstLine(error)})`)
    return false
  }
  if (!authRemote) {
    console.log('ms-upload: MODELSCOPE_TOKEN is missing, staged but not pushed')
    return true
  }
  try {
    git(['-c', 'http.sslVerify=false', 'push', authRemote, `HEAD:${BRANCH}`])
    console.log(`ms-upload: pushed ${plan.length} file(s) to ${DATASET}@${BRANCH}`)
    return true
  } catch (error) {
    console.log(`ms-upload: push rejected (${firstLine(error)}) — re-syncing`)
    return false
  }
}

for (let attempt = 1; attempt <= 4; attempt++) {
  if (await publishOnce(attempt)) process.exit(0)
  await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
}
console.log('ms-upload: gave up after 4 attempts')
process.exit(1)
