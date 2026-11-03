// Union the verified slices the parallel shard jobs uploaded into the carried
// catalogue, so the publish step sees every entry any shard verified.
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const cachePath = join(root, 'data', 'catalog.json')

let cache = { entries: {} }
try {
  cache = JSON.parse(await readFile(cachePath, 'utf8'))
  if (!cache?.entries) cache = { entries: {} }
} catch {
  cache = { entries: {} }
}

const files = (await readdir(dist).catch(() => [])).filter((name) => /^part-.*\.json$/.test(name))
let added = 0
let updated = 0
for (const file of files) {
  const part = JSON.parse(await readFile(join(dist, file), 'utf8'))
  for (const plugin of part.plugins ?? []) {
    const { _sidecar, ...rest } = plugin
    const existed = cache.entries[rest.name] !== undefined
    cache.entries[rest.name] = { plugin: rest, sidecar: _sidecar ?? null, verifiedAt: Date.now() }
    if (existed) updated++
    else added++
  }
}

// Keep the repository bounded: newest verification wins, oldest fall off.
const ordered = Object.entries(cache.entries).sort((a, b) => (b[1].verifiedAt ?? 0) - (a[1].verifiedAt ?? 0)).slice(0, 6000)
await writeFile(cachePath, JSON.stringify({ entries: Object.fromEntries(ordered) }) + '\n')
console.log(`merge-parts: ${files.length} part file(s), +${added} new, ${updated} refreshed, catalogue ${ordered.length}`)
