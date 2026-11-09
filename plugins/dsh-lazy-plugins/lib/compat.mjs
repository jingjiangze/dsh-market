// Runtime-compatibility helpers: the harness denies a plugin whose `engines.dsh` does not
// admit the running version (measured 2026-11-08: dsh-ops@0.4.4 declared
// ">=0.2.0-rc.2 <0.2.2-0" and was silently dropped after the app updated to 0.2.2-rc.1, which
// made ops_bash disappear). These functions answer "is this version string acceptable" and
// "which published version would be", without pulling in a semver dependency.

const parse = (text) => {
  const match = String(text ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  }
}

// Prerelease-aware comparison: 0.2.2-rc.1 < 0.2.2, and rc.1 < rc.2.
const compare = (a, b) => {
  const left = parse(a)
  const right = parse(b)
  if (!left || !right) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (!left.pre.length && !right.pre.length) return 0
  if (!left.pre.length) return 1 // a release outranks its prereleases
  if (!right.pre.length) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    const l = left.pre[index]
    const r = right.pre[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = Number(l)
    const rn = Number(r)
    const lNumeric = Number.isFinite(ln)
    const rNumeric = Number.isFinite(rn)
    if (lNumeric && rNumeric) {
      if (ln !== rn) return ln < rn ? -1 : 1
      continue
    }
    if (lNumeric) return -1 // numeric identifiers sort below alphanumeric ones
    if (rNumeric) return 1
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

const satisfiesComparator = (version, comparator) => {
  const match = comparator.match(/^(>=|<=|>|<|=|\^|~)?\s*(.+)$/)
  if (!match) return true
  const operator = match[1] ?? ''
  const target = match[2].trim()
  const order = compare(version, target)
  if (operator === '>=') return order >= 0
  if (operator === '<=') return order <= 0
  if (operator === '>') return order > 0
  if (operator === '<') return order < 0
  if (operator === '^' || operator === '~') {
    const parsed = parse(target)
    if (!parsed) return true
    const sameMajor = parse(version)?.major === parsed.major
    if (operator === '~') return sameMajor && parse(version)?.minor === parsed.minor && order >= 0
    return sameMajor && order >= 0
  }
  return order === 0
}

// A range is an OR of space-separated AND groups: ">=0.2.0-rc.2 <0.2.2-0 || 0.2.1-rc.2".
export const satisfies = (version, range) => {
  if (!range) return true
  if (!parse(version)) return true
  return String(range)
    .split('||')
    .some((group) => {
      const comparators = group.trim().split(/\s+/).filter(Boolean)
      if (!comparators.length) return true
      // A bare version means an exact match.
      return comparators.every((comparator) => satisfiesComparator(version, comparator))
    })
}

// "-0" style upper bounds are npm's spelling of "any prerelease of the next release counts as
// outside the range"; compare() already puts 0.2.2-rc.1 below 0.2.2, so `<0.2.2-0` must also
// reject 0.2.2-rc.1.
export const satisfiesEngines = (version, range) => {
  if (!satisfies(version, range)) return false
  const upper = String(range).match(/<\s*(\d+\.\d+\.\d+)-0/)
  if (!upper) return true
  return compare(version, `${upper[1]}-0`) < 0
}

export const compareVersions = compare
export { parse as parseVersion }
