// Curation and install confidence, in one place.
//
// The same arithmetic used to be written twice — once in crawler/lang-index.mjs for the
// document DSH reads, once in crawler/browse.mjs for the page — which is how a "精选" badge and
// a "精选" sort could disagree. This module is the single definition; both callers import it.
//
// The score is deliberately made of signals the catalogue can prove, not of one popularity
// number. The indexes this market is measured against lean on a single axis (dsh.so ranks by
// stars, polang by a blended "recommended", the official catalogue has no per-entry ranking at
// all and treats membership as the curation). A market that shows thousands of entries needs
// more than that, so five independent axes are combined:
//
//   corroboration  how many distinct catalogues list it        — agreement between sources
//   traction       stars and weekly downloads, log-scaled      — does anyone use it
//   freshness      how long ago the version was published      — is it alive
//   verification   a registry answered / the source is pinned  — can it actually be installed
//   official       present in the hand-picked official list    — someone vouched for it
//
// Weights add to 100. `trust` stays separate and answers a different question: how much of the
// install path this build was able to verify.
const CJK = /[\u4e00-\u9fff]/

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)))
const log10 = (n) => (n > 0 ? Math.log10(1 + n) : 0)

const WEIGHTS = {
  corroboration: 20,
  traction: 30,
  freshness: 15,
  verification: 20,
  official: 15,
}

// 1 source = 0, 2 = 40, 3 = 70, 4+ = 100
const corroborationScore = (sources) => (sources <= 1 ? 0 : sources === 2 ? 40 : sources === 3 ? 70 : 100)

// 10k stars or 1M weekly downloads each saturate their half. Below that the curve is
// logarithmic so a 200-star plugin still reads differently from a 20-star one.
const tractionScore = (stars, downloads) => {
  const s = Math.min(1, log10(stars) / 4)
  const d = Math.min(1, log10(downloads) / 6)
  return (s * 0.5 + d * 0.5) * 100
}

// Full marks inside a month, gone after two years — a plugin that shipped last week is a
// better opening suggestion than one that has not moved since 2024.
const freshnessScore = (publishTimestamp, now = Date.now()) => {
  if (!publishTimestamp) return 0
  const days = (now - publishTimestamp * 1000) / 86400000
  if (!Number.isFinite(days) || days < 0) return 0
  if (days <= 30) return 100
  if (days >= 730) return 0
  return ((730 - days) / (730 - 30)) * 100
}

export function labelsOf(plugin) {
  return new Set(plugin?.metadata?.labels ?? [])
}

export function sourceCount(plugin) {
  let n = 0
  for (const label of labelsOf(plugin)) if (String(label).startsWith('src-')) n += 1
  return n
}

// Install confidence: only what was checked, never a judgement about the code.
export function trustOf(plugin, probeEntry) {
  const labels = labelsOf(plugin)
  const version = plugin?.versions?.[0] ?? {}
  const verified = Boolean(probeEntry) && (probeEntry.npmmirror === 'ok' || probeEntry.npmjs === 'ok')
  const pinned = version.source?.type === 'git' && /^[0-9a-f]{40}$/i.test(String(version.source.commit ?? ''))
  const declaresEngines = Boolean(version.engines?.dsh)
  let score = 0
  if (verified) score += 40
  if (pinned) score += 30
  if (declaresEngines) score += 20
  score += 10 * Math.min(2, sourceCount(plugin))
  if (labels.has('no-engines')) score -= 20
  return clamp(score)
}

export function curationOf(plugin, { probeEntry, now = Date.now() } = {}) {
  const labels = labelsOf(plugin)
  const version = plugin?.versions?.[0] ?? {}
  const sortKeys = plugin?.metadata?.sortKeys ?? {}
  const stars = Number(sortKeys.stars ?? 0)
  const downloads = Number(sortKeys.downloads ?? 0)

  const parts = {
    corroboration: corroborationScore(sourceCount(plugin)),
    traction: tractionScore(stars, downloads),
    freshness: freshnessScore(Number(version.publishTimestamp ?? sortKeys.updated ?? 0), now),
    verification: trustOf(plugin, probeEntry),
    official: labels.has('src-official') ? 100 : 0,
  }

  let total = 0
  for (const [key, weight] of Object.entries(WEIGHTS)) total += (parts[key] / 100) * weight

  return { curated: clamp(total), trust: parts.verification, parts, breakdown: WEIGHTS }
}

// The value labels the documents carry. Only facts this build established — there is
// deliberately no "low risk" label, because nothing here audits code.
export const CURATION_LABELS = {
  official: { title: { en: 'Official pick', zh: '官方精选' } },
  'install-verified': { title: { en: 'Install verified', zh: '安装已验证' } },
  'source-pinned': { title: { en: 'Pinned source', zh: '源码已固定' } },
  'declares-engines': { title: { en: 'Declares DSH range', zh: '声明兼容版本' } },
  'cross-listed': { title: { en: 'Multi-catalogue', zh: '多目录收录' } },
}

export function curationLabelsFor(plugin, probeEntry) {
  const labels = labelsOf(plugin)
  const version = plugin?.versions?.[0] ?? {}
  const out = new Set()
  if (labels.has('src-official')) out.add('official')
  if (probeEntry && (probeEntry.npmmirror === 'ok' || probeEntry.npmjs === 'ok')) out.add('install-verified')
  if (version.source?.type === 'git' && /^[0-9a-f]{40}$/i.test(String(version.source.commit ?? ''))) out.add('source-pinned')
  if (version.engines?.dsh) out.add('declares-engines')
  if (sourceCount(plugin) >= 3) out.add('cross-listed')
  return [...out]
}

export const CURATION_SORT = {
  curated: { title: { en: 'Curated', zh: '精选度' }, order: 'desc' },
  trust: { title: { en: 'Trust', zh: '可信度' }, order: 'desc' },
}

export const isChinese = (text) => CJK.test(String(text ?? ''))
