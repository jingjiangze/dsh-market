// Practical score — the ranking signal the market uses instead of raw stars.
//
// dsh.market ranks its quiz results by `score.total` ("实用分") and only breaks ties
// with popularity; Steam does the same thing with review score + playtime. Stars
// alone are a bad signal for a plugin catalogue: a repo can be popular for reasons
// unrelated to the plugin, and a brand-new but well-declared plugin has none.
//
// Five dimensions, each 0..1, then weighted into 0..100:
//   declaration  — does it declare engines.dsh (i.e. does it say what it supports)
//   installable  — npm source, or a commit-pinned git source (both really install)
//   maintained   — how recently it was published/updated
//   reception    — stars + downloads, log-scaled so one viral repo cannot dominate
//   coverage     — how many catalogues independently list it
export function practicalScore(entry, now = Date.now()) {
  const version = entry?.versions?.[0] ?? {}
  const labels = entry?.metadata?.labels ?? []
  const sort = entry?.metadata?.sortKeys ?? {}

  const declaration = version.engines?.dsh ? 1 : 0

  const installable = version.source?.type === 'npm' ? 1
    : version.source?.type === 'git' && /^[0-9a-f]{40}$/i.test(String(version.source.commit ?? '')) ? 0.8
      : 0.2

  // 90 days full credit, decaying to 0 at 2 years.
  const published = Number(version.publishTimestamp ?? 0) * (Number(version.publishTimestamp) > 1e12 ? 1 : 1000)
  let maintained = 0.3
  if (published > 0) {
    const days = Math.max(0, (now - published) / 86400000)
    maintained = days <= 90 ? 1 : days >= 730 ? 0 : 1 - (days - 90) / 640
  }

  const stars = Number(sort.stars ?? 0)
  const downloads = Number(sort.downloads ?? 0)
  // log10(1+n)/4 caps at ~10k stars / 10k downloads for a perfect 1.
  const reception = Math.min(1, Math.max(Math.log10(1 + stars) / 4, Math.log10(1 + downloads) / 4.6))

  const sources = new Set(labels.filter((l) => String(l).startsWith('src-')))
  const coverage = Math.min(1, sources.size / 3)

  const parts = { declaration, installable, maintained, reception, coverage }
  const weights = { declaration: 22, installable: 18, maintained: 20, reception: 24, coverage: 16 }
  const total = Object.entries(weights).reduce((sum, [key, weight]) => sum + parts[key] * weight, 0)
  return { total: Math.round(total), parts }
}
