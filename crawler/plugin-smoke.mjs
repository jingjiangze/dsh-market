// Smoke-test the domain candidates by actually installing them, in CI and nowhere else.
//
// Static filters (index row, install-facts, engines.dsh) prove a package exists and is meant
// for this runtime; they cannot prove it activates. This runs the real thing:
//
//   DSH_HOME=<temp>  dsh plugin --profile smoke add <name>@<version>
//
// and records what happened. It never touches a user's profile: the profile lives under a
// temporary DSH_HOME created for this run, and each install is verified then removed so the
// next one starts from a comparable state (the pnpm store stays warm, which is the only
// intended carry-over).
//
// Output is deliberately separate from the domain library (data/plugin-smoke.json), so a
// failed smoke run can never empty or reorder the published domains: plugin-domains.mjs
// applies these verdicts when the file is present, and ignores it otherwise.
//
// Environment:
//   SMOKE_PER        candidates per domain to test (default 1)
//   SMOKE_LIMIT      hard cap on packages per run (default 40)
//   SMOKE_TIMEOUT_MS per-package timeout (default 180000)
//   DSH_BIN          command to run (default "dsh")
//   SMOKE_ONLY       comma list of package names to test (debugging)
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DOMAINS = [join(root, 'site', 'plugin-domains.json'), join(root, 'dist', 'plugin-domains.json')].find((p) => existsSync(p))
const OUT = [join(root, 'data', 'plugin-smoke.json')]
if (!DOMAINS) {
  console.error('plugin-smoke: no domain document; run plugin-domains.mjs first')
  process.exit(1)
}

const PER = Number(process.env.SMOKE_PER || 1)
const LIMIT = Number(process.env.SMOKE_LIMIT || 40)
const TIMEOUT = Number(process.env.SMOKE_TIMEOUT_MS || 180000)
const DSH = process.env.DSH_BIN || 'dsh'
const ONLY = (process.env.SMOKE_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean)

const document = JSON.parse(await readFile(DOMAINS, 'utf8'))
const targets = []
for (const domain of document.domains ?? []) {
  for (const candidate of (domain.candidates ?? []).slice(0, PER)) {
    if (ONLY.length && !ONLY.includes(candidate.name)) continue
    targets.push({ domain: domain.id, ...candidate })
    if (targets.length >= LIMIT) break
  }
  if (targets.length >= LIMIT) break
}

const home = join(tmpdir(), `dsh-smoke-${process.pid}-${Date.now()}`)
const profile = join(home, 'profiles', 'smoke')
await mkdir(profile, { recursive: true })
await writeFile(
  join(profile, 'package.json'),
  JSON.stringify({ name: 'smoke', private: true, version: '0.0.0', dsh: { profile: { bundles: [] } } }, null, 2),
)

const run = (args) => new Promise((resolve) => {
  const started = Date.now()
  execFile(DSH, args, {
    env: { ...process.env, DSH_HOME: home, CI: '1', NO_COLOR: '1' },
    timeout: TIMEOUT,
    maxBuffer: 8 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    resolve({
      ok: !error,
      ms: Date.now() - started,
      error: error ? `${error.message}`.slice(0, 300) : undefined,
      stderr: error ? String(stderr ?? '').trim().split('\n').slice(-6).join(' | ').slice(0, 400) : undefined,
    })
  })
})

// What the install produced: the dependency is declared AND the bundle row is selected.
const inspect = async (name) => {
  try {
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    const declared = Boolean(manifest.dependencies?.[name])
    const bundles = manifest.dsh?.profile?.bundles ?? []
    const selected = bundles.includes(name)
    let hasBundlePatch = false
    try {
      const pkg = JSON.parse(await readFile(join(profile, 'node_modules', name, 'package.json'), 'utf8'))
      hasBundlePatch = Boolean(pkg?.dsh?.bundle?.patch)
    } catch {
      hasBundlePatch = false
    }
    return { declared, selected, hasBundlePatch }
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 200) }
  }
}

const results = {}
let ok = 0
let failed = 0
console.log(`plugin-smoke: ${targets.length} packages, per-domain ${PER}, timeout ${TIMEOUT}ms, home ${home}`)

for (const target of targets) {
  const spec = `${target.name}@${target.version}`
  const install = await run(['plugin', '--profile', 'smoke', 'add', spec])
  const facts = install.ok ? await inspect(target.name) : {}
  const verdict = install.ok && facts.declared && facts.hasBundlePatch ? 'smoke' : 'smoke-failed'
  results[target.name] = {
    domain: target.domain,
    version: target.version,
    tier: verdict,
    ms: install.ms,
    ...facts,
    error: install.error,
    stderr: install.stderr,
  }
  if (verdict === 'smoke') ok += 1
  else failed += 1
  console.log(`${verdict.padEnd(13)} ${target.name}@${target.version} ${install.ms}ms${install.error ? ' :: ' + install.error : ''}`)
  if (install.ok) {
    // Remove so the next package is judged on its own; the pnpm store stays warm on purpose.
    await run(['plugin', '--profile', 'smoke', 'remove', target.name])
  }
}

await rm(home, { recursive: true, force: true })
for (const path of OUT) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({
    format: 'dsh-plugin-smoke',
    schema: 1,
    generatedAt: new Date().toISOString(),
    runtime: document.runtime,
    perDomain: PER,
    tested: Object.keys(results).length,
    ok,
    failed,
    results,
  }, null, 2) + '\n')
}
console.log(`plugin-smoke: ${ok} ok, ${failed} failed -> ${OUT[0]}`)
// Informational by design: a failing package is data, not a broken build.
process.exit(0)
