// Repository-level alias merging.
//
// One project is routinely published under several npm names. The repo
// github.com/Ebony-Vinyl/dsh-our-free-model was listed both as `dsh-channel-pack`
// and as `@Ebony-Vinyl/dsh-our-free-model`; dedupe by name alone kept two cards for
// the same plugin.
//
// A repository is NOT an identity on its own: monorepos ship many plugins from one
// repo (ShiroEirin/dsh-web-ui ships 19) and all of them must survive. So a group is
// merged only when it is small AND exactly one member is named after the repository
// (that member is the canonical package, the others are aliases). Everything else is
// treated as a monorepo and passed through untouched.

const MONOREPO_LIMIT = 2

export function repoKeyOf(plugin) {
  // Any of these can be the only place a source recorded the repository.
  const candidates = [
    plugin?.repository?.url,
    plugin?._sidecar?.r,
    plugin?.versions?.[0]?.source?.type === 'git' ? plugin?.versions?.[0]?.source?.url : null,
    plugin?.hintRepo,
    plugin?.repo,
  ]
  for (const candidate of candidates) {
    const raw = String(candidate ?? '').trim()
    if (!/^(https?:\/\/|git@)/i.test(raw)) continue
    const gh = raw.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i)
    if (gh) {
      const repo = gh[2].replace(/\.git$/i, '').toLowerCase()
      return { key: `${gh[1].toLowerCase()}/${repo}`, owner: gh[1].toLowerCase(), repo }
    }
    const other = raw.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/i)
    if (other) {
      const path = other[2].toLowerCase()
      return { key: `${other[1].toLowerCase()}/${path}`, owner: '', repo: path.split('/').pop() }
    }
  }
  return null
}

function isCanonicalFor(plugin, repo) {
  const name = String(plugin?.name ?? '').toLowerCase()
  if (name === repo.repo) return true
  return Boolean(repo.owner) && (name === `${repo.owner}/${repo.repo}` || name === `@${repo.owner}/${repo.repo}`)
}

// Fold the alias's useful metadata into the survivor so merging never loses facts.
function absorb(winner, lost) {
  const labels = new Set([...(winner.metadata?.labels ?? [])])
  for (const l of lost.metadata?.labels ?? []) labels.add(l)
  const sortKeys = { ...(winner.metadata?.sortKeys ?? {}) }
  for (const [k, v] of Object.entries(lost.metadata?.sortKeys ?? {})) {
    if (sortKeys[k] == null && v != null) sortKeys[k] = v
  }
  winner.metadata = { ...winner.metadata, labels: [...labels], sortKeys }

  winner.versions ??= []
  winner.versions[0] ??= {}
  const w = winner.versions[0]
  const l = lost.versions?.[0] ?? {}
  if (!w.engines?.dsh && l.engines?.dsh) w.engines = l.engines
  if (!w.publishTimestamp && l.publishTimestamp) w.publishTimestamp = l.publishTimestamp
  if ((!w.version || w.version === '0.0.0') && l.version && l.version !== '0.0.0') w.version = l.version
  if (!winner.repository?.url && lost.repository?.url) winner.repository = lost.repository
  return winner
}

export function dedupeByRepo(entries) {
  const groups = new Map()
  const noRepo = []
  for (const plugin of entries) {
    const repo = repoKeyOf(plugin)
    if (!repo) { noRepo.push(plugin); continue }
    if (!groups.has(repo.key)) groups.set(repo.key, { repo, items: [] })
    groups.get(repo.key).items.push(plugin)
  }
  const survivors = []
  let dropped = 0
  const mergedRepos = []
  for (const { repo, items } of groups.values()) {
    const canonical = items.filter((p) => isCanonicalFor(p, repo))
    if (items.length <= MONOREPO_LIMIT && canonical.length === 1) {
      const winner = canonical[0]
      const aliases = items.filter((p) => p !== winner)
      for (const alias of aliases) absorb(winner, alias)
      survivors.push(winner)
      dropped += aliases.length
      mergedRepos.push({ repo: repo.key, winner: winner.name, aliases: aliases.map((p) => p.name) })
    } else {
      survivors.push(...items)
    }
  }
  return { entries: [...survivors, ...noRepo], dropped, mergedRepos }
}
