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
const SCALE = 4.2 // log10(1+10k) ≈ 4.0, so 10k stars or downloads is about full marks

export function heatOf(entry) {
  const sort = entry?.metadata?.sortKeys ?? {}
  const stars = Number(sort.stars ?? 0)
  const downloads = Number(sort.downloads ?? 0)
  if (!(stars > 0) && !(downloads > 0)) return 0
  const starPart = stars > 0 ? Math.log10(1 + stars) : 0
  const downloadPart = downloads > 0 ? Math.log10(1 + downloads) : 0
  const blended = starPart * STAR_WEIGHT + downloadPart * DOWNLOAD_WEIGHT
  return Math.max(0, Math.min(100, Math.round((blended / SCALE) * 100)))
}
