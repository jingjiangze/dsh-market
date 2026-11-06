// Publishes the install target for every index entry: `dist/install-targets.json`,
// mirrored to `site/install-targets.json` because GitHub Pages serves `site/`.
//
// WHY THIS EXISTS
// Format 1 carries one `name` per entry, and that name is not always the package a
// client can `npm i`. When two upstream listings share a display name the catalogue
// appends a dedupe suffix — `dsh-voice` becomes `dsh-voice-8`, `@scope/pkg` becomes
// `@scope/pkg-2` — and the real package name survives only in `title`. Measured on
// the live index: `npm i dsh-voice-8` answers 404 from npmmirror while entry
// `dsh-voice-8` (version 0.4.2) installs as `dsh-voice@0.4.2`. A client that
// trusts `name` spends seconds on a request that cannot succeed.
//
// WHY IT IS A DIFF AND NOT A MIRROR
// 10,995 entries would make a ~2 MB second document for facts the client can derive
// from the index it already has (`install = name`, `version = versions[0].version`).
// So `targets` lists ONLY the exceptions; a name that is absent from `targets` means
// the default rule applies. That keeps the file ~1/60th of the index.
//
// HOW AN ALIAS IS PROVEN
// `title` is a localized display string, not a package name, so it is never trusted
// on its own: both `dsh-plugin-wallpaper-engine` and `dsh-wallpaper-engine` exist on
// npm, and switching a healthy name to its title would silently install a DIFFERENT
// package. An override needs either a probe result for that exact name, or the
// dedupe signature (the name is `title` plus a `-<digits>` suffix) — which is
// exactly the rename the crawler creates.
//
//   node crawler/emit-install-targets.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = process.env.INSTALL_TARGETS_INDEX || join(root, 'dist', 'index.zh.json')
const OUT = [join(root, 'dist', 'install-targets.json'), join(root, 'site', 'install-targets.json')]
// Where a China-facing install should fetch from, matching lang-index.mjs.
const DEFAULT_REGISTRY = process.env.CN_REGISTRY || 'https://registry.npmmirror.com'
// Optional existence probes: { "<name>": true|false }. Never fetched here — the
// crawl already records what it probed, and scanning 11k names on every build is
// not acceptable. Without one, `absent` simply stays empty.
const PROBES = [join(root, 'data', 'npm-probe-cache.json'), join(root, 'data', '2bingling-npm.json')]

// npm's own rule for a publishable name: lowercase, URL-safe, optionally scoped.
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const isNpmName = (value) => typeof value === 'string' && value.length <= 214 && NPM_NAME.test(value)
// The suffix the catalogue appends when two listings collide.
const DEDUPE_SUFFIX = /^(.*)-\d+$/
const unscoped = (name) => name.slice(name.indexOf('/') + 1)
const textOf = (value) => (typeof value === 'string' ? value : (value?.en ?? ''))

const index = JSON.parse(await readFile(INDEX, 'utf8'))
const plugins = index.plugins ?? []

let probe = null
let probeFile = null
for (const file of PROBES) {
  if (!existsSync(file)) continue
  try {
    probe = JSON.parse(await readFile(file, 'utf8'))
    probeFile = file.slice(root.length + 1)
    break
  } catch {
    // A truncated cache is not a reason to fail the build.
  }
}
const probed = (name) => (probe && Object.prototype.hasOwnProperty.call(probe, name) ? probe[name] === true : null)

function resolve(entry) {
  const name = String(entry.name ?? '')
  const version = entry.versions?.[0] ?? {}
  const source = version.source ?? {}
  const registry = source.registry ?? DEFAULT_REGISTRY

  // A git-pinned version is installed from its URL: there is no package name to use.
  if (source.type && source.type !== 'npm' && source.url) {
    return { install: String(source.url), version: version.version ?? '', registry: '', alias: true, why: 'git-source' }
  }

  const asIs = (why) => ({ install: name, version: version.version ?? '', registry, alias: false, why })
  const asTitle = (why) => ({ install: title, version: version.version ?? '', registry, alias: true, why })

  // A probe answer about this exact name outranks every guess.
  const nameProbe = probed(name)
  if (nameProbe === true) return asIs('probed')

  const title = textOf(entry.title)
  // Only a real npm name can be an install target; a display title ("DSH_VsCodeMode",
  // "Vibe-Mathematics") is not one.
  const titleUsable = title !== name && isNpmName(title)
  const titleProbe = titleUsable ? probed(title) : null
  // The dedupe signature: `name` is the title plus a `-<digits>` suffix. Measured on a
  // 40-entry sample of these names, 39 answered 404 and 0 answered 200, so switching
  // to the title cannot break a name that works — at worst both stay dead.
  const base = DEDUPE_SUFFIX.exec(name)?.[1]
  const shapeOk = Boolean(base) && titleUsable && (title === base || unscoped(title) === unscoped(base))

  if (nameProbe === false) {
    if (titleProbe === true) return asTitle('title-probed')
    if (shapeOk && titleProbe !== false) return asTitle('dedupe-suffix')
    // Nothing proven installable: keep the name so the entry still lists, and let it
    // fall into `absent` below.
    return asIs('name-dead')
  }
  if (shapeOk && titleProbe !== false) return asTitle(titleProbe === true ? 'title-probed' : 'dedupe-suffix')
  return asIs('name')
}

const targets = {}
const absent = []
const reasons = {}
for (const entry of plugins) {
  const target = resolve(entry)
  reasons[target.why] = (reasons[target.why] ?? 0) + 1
  if (target.alias) {
    const { why, ...published } = target
    targets[entry.name] = published
  }
  // Only a probed answer can prove an install target is dead.
  if (probed(target.install) === false) absent.push(entry.name)
}

const document = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  source: INDEX.slice(root.length + 1).replaceAll('\\', '/'),
  defaultRule: 'entries missing from `targets` install as `<name>@<versions[0].version>` from their own source.registry',
  counts: { entries: plugins.length, aliases: Object.keys(targets).length, absent: absent.length },
  targets,
  absent,
}
const body = `${JSON.stringify(document)}\n`
for (const file of OUT) await writeFile(file, body)

const gzip = gzipSync(Buffer.from(body)).length
console.log(`entries   ${plugins.length}`)
console.log(`aliases   ${Object.keys(targets).length} ${JSON.stringify(reasons)}`)
console.log(`absent    ${absent.length}${probeFile ? ` (probe: ${probeFile})` : ' (no probe cache found, skipped)'}`)
console.log(`bytes     ${body.length} raw / ${gzip} gzip`)
console.log(`written   ${OUT.map((file) => file.slice(root.length + 1)).join(', ')}`)
