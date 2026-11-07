// The install-facts document, separate from the format-1 index.
//
// Measured on the catalogue: of everything an on-demand loader wants, format 1 already
// carries almost all of it — title, description, category, curated/trust sortKeys, engines,
// version and source. The facts it cannot express are narrow:
//
//   * whether a registry actually serves the package (`installable`)
//   * the real install target when a row's name was renamed (`installAs`) — currently zero
//     exceptions, because crawler/restore-alias.mjs repairs the name instead of aliasing it
//
// So this is a DIFF, not a second copy of the catalogue: it lists the rows that are NOT
// installable plus the ones the probe could not decide. A loader reads the format-1 document
// it already has and treats every name absent from both lists as installable — that is
// exactly the `installable: false` test plugins/dsh-lazy-plugins does today, except with real
// data instead of a string guess.
//
// Duplicating the catalogue here cost 5.65 MB, and would have added that much to git history
// on every crawl: the same bloat the 20 MB aggregate was removed for.
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

const notInstallable = []
const unverified = []

for (const plugin of plugins) {
  const version = plugin.versions?.[0] ?? {}
  const name = String(plugin.name ?? '')
  if (!name) continue
  const source = version.source ?? {}

  if (source.type === 'git') {
    if (!/^[0-9a-f]{40}$/i.test(String(source.commit ?? ''))) notInstallable.push(name)
    continue
  }

  const result = probe[name]
  if (!result) { unverified.push(name); continue }
  if (result.npmmirror === 'ok' || result.npmjs === 'ok') continue
  // Only a definitive miss from both registries disqualifies a row; a timeout or a 429 says
  // nothing about whether the package exists, and the crawl itself provokes those.
  if (result.npmmirror === 'missing' && result.npmjs === 'missing') notInstallable.push(name)
  else unverified.push(name)
}

const document = {
  format: 'dsh-plugin-install-facts',
  schema: 1,
  generatedAt: new Date().toISOString(),
  count: plugins.length,
  // Absent from both lists = installable from the source the index states.
  notInstallable,
  unverified,
}
const text = JSON.stringify(document)
for (const path of OUT) await writeFile(path, text + '\n')
console.log(`plugin-index: ${plugins.length} rows, ${notInstallable.length} not installable, ${unverified.length} unverified, ${(Buffer.byteLength(text) / 1024).toFixed(0)} KB`)
