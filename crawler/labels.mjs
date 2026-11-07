// The `no-engines` label is a claim about `versions[0]`: it says the package never
// declared `engines.dsh`. Two places can change either side of that claim after the
// row was built — `crawl.mjs` fills engines from npm metadata, and `restore-alias.mjs`
// merges a renamed row into an existing one (unions labels, then adopts the richer
// row's engines). Doing the reconciliation inline in only one of them is what shipped
// 93 rows carrying both `no-engines` and a real `engines.dsh` range, which the release
// gate (`validate.mjs:74`) rejects. So the rule lives here and every writer calls it.
//
// The predicate deliberately mirrors `validate.mjs:70`
// (`versions[0]?.engines?.dsh !== undefined`), so the two can never drift apart.

export function declaresEngines(plugin) {
  return plugin?.versions?.[0]?.engines?.dsh !== undefined
}

// Returns how many rows changed, so callers can log the same way they always did.
export function reconcileEnginesLabel(plugins) {
  let changed = 0
  for (const plugin of plugins) {
    const labels = new Set(plugin.metadata?.labels ?? [])
    const declares = declaresEngines(plugin)
    const had = labels.has('no-engines')
    // A verified entry that declares engines must not keep the label. A catalog-only
    // row that still declares nothing must carry it, because validate.mjs requires one
    // of the two.
    if (declares && had) labels.delete('no-engines')
    else if (!declares && !had && labels.has('catalog-only')) labels.add('no-engines')
    else continue
    plugin.metadata = { ...plugin.metadata, labels: [...labels] }
    changed++
  }
  return changed
}
