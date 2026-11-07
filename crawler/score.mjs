// Combined popularity — the single ranking number the site shows.
//
// Stars alone favour old repositories; downloads alone favour whatever npm mirrors
// happen to count. This merges both, log-scaled so one viral repo cannot flatten the
// rest, and returns 0..100.
//
// An earlier version also scored declaration/maintenance/coverage. That turned the
// number into a quality verdict nobody asked for; the market now ranks by popularity
// only and lets the trust and install-grade badges carry the quality signals.
const STAR_WEIGHT = 0.55
const DOWNLOAD_WEIGHT = 0.45

// A fixed SCALE saturated: with the real catalogue almost everything above a few
// hundred stars scored a flat 100, so "sort by heat" produced exactly the same order as
// "sort by stars". Normalise against this run's own maxima instead — heat then spreads
// across 0..100 and actually discriminates.
export function heatMaxima(entries) {
  let stars = 0
  let downloads = 0
  for (const entry of entries ?? []) {
    const sort = entry?.metadata?.sortKeys ?? {}
    stars = Math.max(stars, Number(sort.stars ?? 0))
    downloads = Math.max(downloads, Number(sort.downloads ?? 0))
  }
  return { stars, downloads }
}

export function heatOf(entry, maxima) {
  const sort = entry?.metadata?.sortKeys ?? {}
  const stars = Number(sort.stars ?? 0)
  const downloads = Number(sort.downloads ?? 0)
  if (!(stars > 0) && !(downloads > 0)) return 0
  const starCap = Math.log10(1 + Math.max(stars, maxima?.stars ?? 0, 10))
  const downloadCap = Math.log10(1 + Math.max(downloads, maxima?.downloads ?? 0, 10))
  const starPart = stars > 0 ? Math.log10(1 + stars) / starCap : 0
  const downloadPart = downloads > 0 ? Math.log10(1 + downloads) / downloadCap : 0
  const blended = starPart * STAR_WEIGHT + downloadPart * DOWNLOAD_WEIGHT
  return Math.max(0, Math.min(100, Math.round(blended * 100)))
}
