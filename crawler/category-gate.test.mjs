// Offline test for the publishing gate. No network, no dist/: the fixtures are inline.
//
//   node crawler/category-gate.test.mjs
//
// The regression it pins: a stale dist/index.json once republished categories the
// taxonomy no longer declares (work / data / connect / …) and every downstream check
// passed, because nothing compared the document against the taxonomy.
import assert from 'node:assert/strict'
import { assertKnownCategories, unknownCategories } from './category-gate.mjs'
import { CATEGORIES } from './taxonomy.mjs'

const leaf = Object.keys(CATEGORIES)[0]
let checks = 0
let failed = 0
const check = (name, fn) => {
  checks++
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    console.error(`  FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

// 1. the shape that broke production: 14 coarse ids copied out of an old build
const stale = [
  { name: 'dsh-a', metadata: { category: 'work' } },
  { name: 'dsh-b', metadata: { category: 'work' } },
  { name: 'dsh-c', metadata: { category: 'data' } },
  { name: 'dsh-d', metadata: { category: leaf } },
]
check('a stale document is rejected', () => {
  assert.throws(() => assertKnownCategories(stale, 'index.zh.json'), /refusing to publish 3 entries/)
})
check('the error names the offending categories and a sample entry', () => {
  const message = (() => { try { assertKnownCategories(stale, 'index.zh.json') } catch (error) { return error.message } })()
  assert.match(message, /work\s+2\s+e\.g\. dsh-a, dsh-b/)
  assert.match(message, /data\s+1/)
  assert.match(message, /crawler\/crawl\.mjs/)
})
check('unknownCategories counts and sorts by usage', () => {
  const rows = unknownCategories(stale)
  assert.deepEqual(rows.map((row) => [row.category, row.count]), [['work', 2], ['data', 1]])
})

// 2. what a healthy document looks like
check('a document using only declared leaves passes', () => {
  assertKnownCategories([{ name: 'dsh-a', metadata: { category: leaf } }, { name: 'dsh-b', metadata: { category: 'other' } }])
})
check('an empty document passes', () => {
  assertKnownCategories([])
})

// 3. missing is not the same as unknown: a document with no category at all is broken
check('a missing category is reported rather than ignored', () => {
  const rows = unknownCategories([{ name: 'dsh-x', metadata: {} }])
  assert.deepEqual(rows.map((row) => row.category), ['(missing)'])
})

console.log(failed ? `\nFAIL ${failed}/${checks}` : `\nPASS ${checks}/${checks}`)
