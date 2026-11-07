// The plugin-facing index, separate from the format-1 document the client subscribes to.
//
// Why it exists: format 1 drops any member it does not define, so the facts an on-demand
// plugin loader needs have nowhere to live in it — the real install target when a row was
// renamed, whether a registry actually serves the package, and the curation/trust numbers.
// `plugins/dsh-lazy-plugins` currently works around that: its ranking module collapses rows
// by `installAs ?? name` and hides entries with `installable: false`, i.e. it re-derives
// exactly these fields from strings.
//
// This publishes them once, in their own document, so the client's format stays untouched
// and the loader stops guessing.
//
//   node crawler/plugin-index.mjs      # writes site/plugin-index.json
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = join(root, 'dist', 'index.json')
const PROBE = join(root, 'data', 'npm-probe.json')
const OUT = [join(root, 'dist', 'plugin-index.json'), join(root, 'site', 'plugin-index.json')]

const index = JSON.parse(await readFile(INDEX, 'utf8'))
const probe = existsSync(PROBE) ? JSON.parse(await readFile(PROBE, 'utf8')) : {}
const plugins = index.plugins ?? []

const text = (value) => {
  if (typeof value === 'string') return value
  return value?.zh ?? value?.en ?? ''
}

const resolveSource = (version) => {
  const source = version?.source ?? {}
  if (source.type === 'git') {
    return {
      type: 'git',
      url: String(source.url ?? ''),
      commit: String(source.commit ?? ''),
      ...(source.path ? { path: source.path } : {}),
    }
  }
  return { type: 'npm', ...(source.registry ? { registry: source.registry } : {}) }
}

const rows = []
let installable = 0
for (const plugin of plugins) {
  const version = plugin.versions?.[0] ?? {}
  const name = String(plugin.name ?? '')
  if (!name) continue
  const source = resolveSource(version)
  const result = probe[name]
  // A pinned commit is installable by construction; an npm row is installable only when a
  // registry answered. Entries with no probe are left as unknown rather than assumed good.
  const known = source.type === 'git'
    ? /^[0-9a-f]{40}$/i.test(source.commit)
    : result
      ? result.npmmirror === 'ok' || result.npmjs === 'ok'
      : null
  const title = text(plugin.title)
  // The real install target. restore-alias renames rows to the package name, so this is
  // normally identical; keeping the field tells the loader the two were checked.
  const installAs = name
  const row = {
    name,
    // Omitted when it equals the name — the loader reads `installAs ?? name`, so repeating
    // the same string 15k times buys nothing.
    ...(installAs !== name ? { installAs } : {}),
    installable: known === true,
    ...(known === null ? { unverified: true } : {}),
    version: String(version.version ?? ''),
    ...(title && title !== name ? { title } : {}),
    description: text(plugin.description),
    category: plugin.metadata?.category ?? 'other',
    ...(typeof plugin.metadata?.sortKeys?.curated === 'number' ? { curated: plugin.metadata.sortKeys.curated } : {}),
    ...(typeof plugin.metadata?.sortKeys?.trust === 'number' ? { trust: plugin.metadata.sortKeys.trust } : {}),
    ...(version.engines?.dsh ? { engines: version.engines.dsh } : {}),
    source,
  }
  if (row.installable) installable++
  rows.push(row)
}

const document = {
  format: 'dsh-plugin-index',
  schema: 1,
  generatedAt: new Date().toISOString(),
  count: rows.length,
  installable,
  plugins: rows,
}
const text_ = JSON.stringify(document)
for (const path of OUT) await writeFile(path, text_ + '\n')
console.log(`plugin-index: ${rows.length} rows, ${installable} installable, ${(Buffer.byteLength(text_) / 1048576).toFixed(2)} MB`)
