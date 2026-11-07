// Offline test for the 2BingLing adapter's degradation path.
//
//   node crawler/source-2bingling.test.mjs
//
// The failure it pins down: on 2026-11-07 the upstream catalogue started answering 403
// to GitHub runners, source-2bingling.mjs threw on the first non-OK response, and the
// publish chain failed 20+ times in a row — leaving the live index on a stale dist.
// An enrichment source that is unreachable must degrade, not take the build down.
//
// Every case runs the real script as a child process against a temp data directory,
// with `fetch` replaced through a preload module. Nothing touches data/ or the network.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'source-2bingling.mjs')
const workdir = mkdtempSync(join(tmpdir(), 'bingling-test-'))

// The fake network. Mode comes from FAKE_MODE so one file covers every case.
const preload = join(workdir, 'fake-fetch.mjs')
writeFileSync(preload, `
const mode = process.env.FAKE_MODE
const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
const DOC = {
  generatedAt: '2026-11-07T00:00:00Z',
  plugins: [
    { name: 'alpha', type: 'cordis-plugin', stars: 5, fullName: 'a/alpha', description: 'Alpha tool', tags: ['工具集成'] },
    { name: 'beta', type: 'cordis-plugin', stars: 3, fullName: 'b/beta', description: 'Beta tool now' },
    { name: 'not-a-plugin', type: 'skill', stars: 9, fullName: 'c/gamma' },
  ],
}
globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.includes('plugins-lite.json')) {
    if (mode === '403') return { ok: false, status: 403, json: async () => ({}), text: async () => '' }
    if (mode === '500') return { ok: false, status: 500, json: async () => ({}), text: async () => '' }
    if (mode === 'timeout') { const e = new Error('The operation was aborted'); e.name = 'TimeoutError'; throw e }
    if (mode === 'garbage') return { ok: true, status: 200, text: async () => '<html>not json</html>', json: async () => ({}) }
    return json(DOC)
  }
  if (u.includes('registry.npmjs.org/alpha')) return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
  if (u.includes('registry.npmjs.org/beta')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  if (u.includes('/repos/b/beta/commits/')) return json({ sha: 'a'.repeat(40) })
  if (u.includes('/repos/b/beta')) return json({ default_branch: 'main' })
  return json({})
}
`)

let failed = 0
let checks = 0
const check = (name, fn) => {
  checks++
  try { fn(); console.log(`  ok   ${name}`) } catch (error) { failed++; console.error(`  FAIL ${name}: ${error.message}`) }
}

// Fresh data directory per case; `seed` pre-writes a records file (the committed copy).
const run = (mode, env = {}, seed = null) => {
  const data = mkdtempSync(join(workdir, 'data-'))
  if (seed) writeFileSync(join(data, '2bingling-records.json'), seed)
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_MODE: mode, BINGLING_DATA_DIR: data, BINGLING_MIN_STARS: '1', ...env },
  })
  return { ...result, data, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

// 1. the exact production failure
{
  const runResult = run('403', {}, '[{"seed":"previous records"}]')
  check('403 exits 0 instead of failing the build', () => {
    if (runResult.status !== 0) throw new Error(`exit ${runResult.status}: ${runResult.output.trim()}`)
  })
  check('403 logs one greppable skip line', () => {
    if (!/2bingling: skipped \(HTTP 403\) — continuing without it/.test(runResult.output)) throw new Error(runResult.output.trim())
  })
  check('403 leaves the previous records file untouched', () => {
    const content = readFileSync(join(runResult.data, '2bingling-records.json'), 'utf8')
    if (content !== '[{"seed":"previous records"}]') throw new Error(`records rewritten: ${content.slice(0, 80)}`)
  })
}

// 2. the other outage shapes
for (const [mode, pattern] of [['500', /HTTP 500/], ['timeout', /timeout/], ['garbage', /unparseable document/]]) {
  const runResult = run(mode)
  check(`${mode} degrades instead of throwing`, () => {
    if (runResult.status !== 0) throw new Error(`exit ${runResult.status}: ${runResult.output.trim()}`)
    if (!pattern.test(runResult.output)) throw new Error(runResult.output.trim())
  })
}

// 3. strict mode is opt-in
{
  const runResult = run('403', { BINGLING_REQUIRED: '1' })
  check('BINGLING_REQUIRED=1 turns the outage back into a failure', () => {
    if (runResult.status === 0) throw new Error('expected a non-zero exit')
    if (!/BINGLING_REQUIRED=1/.test(runResult.output)) throw new Error(runResult.output.trim())
  })
}

// 4. the happy path still produces records
{
  const runResult = run('ok')
  check('a healthy catalogue still produces records', () => {
    if (runResult.status !== 0) throw new Error(`exit ${runResult.status}: ${runResult.output.trim()}`)
    const records = JSON.parse(readFileSync(join(runResult.data, '2bingling-records.json'), 'utf8'))
    if (records.length !== 2) throw new Error(`expected 2 records, got ${records.length}: ${JSON.stringify(records.map((r) => r.name))}`)
    const beta = records.find((r) => r.name === 'beta')
    if (!beta?.gitSource?.commit) throw new Error('npm-404 entry lost its pinned commit')
    const alpha = records.find((r) => r.name === 'alpha')
    if (!alpha || alpha.gitSource) throw new Error('npm entry should not carry a git source')
    if (records.some((r) => r.name === 'not-a-plugin')) throw new Error('skill entries must stay filtered out')
    if (!/2BingLing: 2 candidates -> 2 installable/.test(runResult.output)) throw new Error(runResult.output.trim())
  })
}

rmSync(workdir, { recursive: true, force: true })
console.log(failed ? `\nFAIL ${failed}/${checks}` : `\nPASS ${checks}/${checks}`)
process.exitCode = failed ? 1 : 0
