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
const firstLine = (error) => String(`${error.message ?? error}`).split('\n').find((line) => line.trim()) ?? 'unknown error'

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
// A shallow clone often cannot rebase; the platform also appends its own commits to
// dataset_infos.json, so a failed pull is tolerated and the push follows.
try {
  git(['pull', '--rebase', 'origin', BRANCH])
} catch (error) {
  console.log(`ms-upload: pull skipped (${String(error.message).split('\n')[0]})`)
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
if (existsSync(browseRoot)) {
  const { readdir } = await import('node:fs/promises')
  for (const file of await readdir(browseRoot)) {
    plan.push({ from: join(browseRoot, file), to: `web/browse/${file}` })
  }
}
if (!plan.length) {
  console.log('ms-upload: nothing to publish')
  process.exit(0)
}

let changed = 0
for (const entry of plan) {
  const target = join(REPO, entry.to.replace(/\//g, '\\').replace(/^web\\/, 'web\\'))
  const current = existsSync(target) ? await readFile(target) : null
  const next = await readFile(entry.from)
  if (current && current.equals(next)) continue
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, next)
  changed++
}
console.log(`ms-upload: ${plan.length} file(s) planned, ${changed} to write`)
if (!changed) process.exit(0)
if (DRY) process.exit(0)

// Identity and sparse checkout are configured explicitly: on a fresh runner the
// dataset clone has no user config, and a failed commit there is otherwise opaque.
try {
  git(['config', 'user.name', 'dsh-market-bot'])
  git(['config', 'user.email', 'dsh-market-bot@users.noreply.github.com'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['add', '-A', 'web'])
} catch (error) {
  console.log(`ms-upload: staging failed (${firstLine(error)})`)
  process.exit(1)
}
if (DRY) process.exit(0)

let committed = false
try {
  const out = git(['commit', '-m', `publish site assets (${changed} file(s))`])
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
console.log(`ms-upload: pushed ${changed} file(s) to ${DATASET}@${BRANCH}`)
