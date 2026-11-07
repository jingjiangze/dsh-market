// Offline self-test for the category rules. No network, no `dist/` needed: the
// fixture in category-fixture.json carries the real entry text and the label each
// entry *should* get, so the gate runs in CI and on a fresh checkout.
//
//   node crawler/category-selftest.mjs
//
// `was` is what the pre-change taxonomy produced for exactly these inputs (recorded
// when the fixture was generated), so this compares like for like rather than
// guessing what the old rules would have done.
//
// Exit codes: 0 = pass, 1 = a regression or a missing fix.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATEGORIES, categoryFor } from './taxonomy.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// The ratchet: at least this many entries must go from wrong to right, and the number
// of entries that were already right and got broken must never grow past its ceiling.
// Raising the ceiling is a decision, not an accident — see the PR body for the review.
const MIN_FIXED = Number(process.env.CATEGORY_MIN_FIXED ?? 55)
const MAX_REGRESSED = Number(process.env.CATEGORY_MAX_REGRESSED ?? 15)

const { entries } = JSON.parse(readFileSync(join(root, 'crawler', 'category-fixture.json'), 'utf8'))
const leaves = new Set(Object.keys(CATEGORIES))

let fixed = 0
let regressed = 0
let stillWrong = 0
let alreadyOk = 0
const regressions = []
const stillWrongRows = []
const fixedRows = []
const unknownLeaf = []

for (const entry of entries) {
  if (!leaves.has(entry.want)) { unknownLeaf.push(`${entry.name} -> ${entry.want}`); continue }
  const record = entry.tags?.length ? { hintTags: entry.tags } : null
  const now = categoryFor(record, entry.text)
  const wasWrong = entry.was !== entry.want
  if (now === entry.want) {
    if (wasWrong) { fixed++; fixedRows.push(`${entry.name}: ${entry.was} -> ${now}`) } else alreadyOk++
  } else {
    if (wasWrong) { stillWrong++; stillWrongRows.push(`${entry.name}: want ${entry.want}, was ${entry.was}, now ${now}`) } else { regressed++; regressions.push(`${entry.name}: was ${entry.was}, now ${now} (want ${entry.want})`) }
  }
}

const total = entries.length
const pct = (n) => `${((100 * n) / total).toFixed(1)}%`
console.log(`category rules v4 — fixture ${total} real entries`)
console.log(`  fixed        ${fixed}  (was wrong, now right)`)
console.log(`  held         ${alreadyOk}  (was right, still right)`)
console.log(`  regressed    ${regressed}  (was right, now wrong)`)
console.log(`  still wrong  ${stillWrong}`)
console.log(`  accuracy     ${((100 * (fixed + alreadyOk)) / total).toFixed(1)}%  (was ${((100 * (alreadyOk + regressed)) / total).toFixed(1)}%)`)

if (regressions.length) {
  console.log('\nregressions:')
  for (const row of regressions) console.log('  ' + row)
}
if (unknownLeaf.length) {
  console.log('\nlabels that are not taxonomy leaves:')
  for (const row of unknownLeaf) console.log('  ' + row)
}
if (process.env.CATEGORY_VERBOSE === '1') {
  console.log('\nfixed:')
  for (const row of fixedRows) console.log('  ' + row)
  console.log('\nstill wrong:')
  for (const row of stillWrongRows) console.log('  ' + row)
}

const problems = []
if (regressed > MAX_REGRESSED) problems.push(`${regressed} regression(s), ceiling ${MAX_REGRESSED}`)
if (fixed < MIN_FIXED) problems.push(`only ${fixed} fixed, need >= ${MIN_FIXED}`)
if (unknownLeaf.length) problems.push(`${unknownLeaf.length} fixture label(s) outside the taxonomy`)

if (problems.length) {
  console.error('\nFAIL: ' + problems.join('; '))
  process.exit(1)
}
console.log('\nPASS')
