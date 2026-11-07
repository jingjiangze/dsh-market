// Stop a bulk step before it spends the quota the publish step needs.
//
// The crawler shares one installation token: whatever the star/download fill, the git
// pins and the 2BingLing commit lookups leave behind is what the publish gets. Reserving
// a floor here is the difference between "this run enriches fewer entries" and "this run
// publishes nothing at all".
export function reserveReached(response, reserve = Number(process.env.API_RESERVE || 400)) {
  const remaining = Number(response?.headers?.get?.('x-ratelimit-remaining') ?? NaN)
  return Number.isFinite(remaining) && remaining <= reserve
}
