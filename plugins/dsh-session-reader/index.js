/**
 * dsh-session-reader — v1.0.0
 *
 * Read OTHER DSH sessions: list them, full-text search across them, and read one
 * complete conversation. Read-only, no telemetry, nothing leaves the machine.
 *
 * Data source priority (see `resolve()`, `corpus()`):
 *   1. Host service `sessionQuery` (optional, obtained with `ctx.get('sessionQuery')`
 *      so a Host without the service still loads). Methods used — signatures confirmed
 *      against `cordis_inspect_query(platform=host, provider=Service, service='sessionQuery')`:
 *        listSessions(signal?)            -> SessionRecord[] {header{id,createdAt,cwd,
 *                                            parentSession,isSeeded,origin,delegationDepth,
 *                                            agentPreset}, live, persisted, formatStatus}
 *        readSession(sessionId)           -> SessionLogSnapshot {session, inheritedEventCount,
 *                                            events: SessionEvent[]}   // full raw log
 *        readTitleSnapshots(ids, signal?) -> [{sessionId,status,value:{title?}}]
 *      Deliberately NOT `readSurface()`: compaction replaces old events on the model
 *      surface with `compaction/summary`, so the surface is lossy. Borrowed judgement
 *      from `dsh-archive-viewer@1.1.5` (docs/INTERNALS.md:44).
 *      Deliberately NOT `searchSessions`/`searchEvents`: those are the *abstract* methods
 *      of the service and need the SQLite FTS5 backend, whose `unicode61` tokenizer does
 *      not split a run of CJK ideographs (`dsh-session-history-search@0.1.0`, index.js:13),
 *      and whose index db (`~/.dsh/session-query.sqlite`) is absent on a default profile.
 *      We match literal substrings in JS instead: CJK-correct, and one code path for both
 *      the service and the disk fallback.
 *
 *   2. Disk fallback, when no service is reachable:
 *      ~/.dsh/sessions/<cwd-slug>/<sessionId>/session.v4.jsonl.zstd
 *      That file is a stack of CONCATENATED zstd frames (one per append), so a plain
 *      `zstd -d` returns only the first record; `decodeZstdFrames()` walks frame magic
 *      bytes greedily. Each line is `{type, seq, time, data}`.
 *
 *   3. Neither available -> `{ unavailable: true, reason, tried }`, never a bare throw.
 *
 * Borrowed behaviour and its sources: CREDITS.md. No telemetry, no reporting.
 */

import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'

export const inject = ['tools']

export const name = 'dsh-session-reader'

const VERSION = '1.0.0'

// Hard caps that keep one tool result small enough to stay useful in context.
const MAX_BYTES = 20000
const MAX_LIMIT = 30
const MAX_READ_MESSAGES = 60
const MAX_MESSAGE_CHARS = 2000
const SNIPPET_PAD = 60
const CACHE_TTL_MS = 60000
const CACHE_MAX = 40
const MAX_SCAN_SESSIONS = 60

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

// A tool result must be lossless JSON: no undefined members, no NaN/Infinity.
const clean = (value) => {
  if (Array.isArray(value)) return value.map(clean)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      if (typeof item === 'number' && !Number.isFinite(item)) continue
      if (typeof item === 'function') continue
      out[key] = clean(item)
    }
    return out
  }
  return value
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : undefined)

// Session ids come in two shapes on this machine: a bare uuid, and `session-<uuid>`.
// Stripping that prefix is what makes an 8-char short id unique; otherwise every
// prefixed id collapses to the useless "session-".
const BARE_PREFIX = /^session-/
const bareId = (id) => (typeof id === 'string' ? id.replace(BARE_PREFIX, '') : id)
const shortId = (id) => {
  const bare = bareId(id)
  return typeof bare === 'string' ? bare.slice(0, 8) : bare
}

const failure = (code, message) => {
  const error = new Error(message)
  error.code = code
  return error
}

const bytesOf = (value) => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')

// Clip a payload's item list until the serialized result fits the byte budget.
// `offset` is the number of items the caller already skipped, so the cursor is absolute.
const fit = (payload, key, offset, limitBytes = MAX_BYTES) => {
  const items = Array.isArray(payload[key]) ? payload[key] : []
  let kept = items.length
  let json = JSON.stringify({ ...payload, [key]: items.slice(0, kept) })
  while (kept > 0 && Buffer.byteLength(json, 'utf8') > limitBytes) {
    const step = Math.max(1, Math.ceil(kept / 8))
    kept = Math.max(0, kept - step)
    json = JSON.stringify({ ...payload, [key]: items.slice(0, kept) })
  }
  const truncated = kept < items.length
  return {
    ...payload,
    [key]: items.slice(0, kept),
    returned: kept,
    truncated,
    ...(truncated ? { nextCursor: `offset:${offset + kept}` } : {}),
  }
}

/* ------------------------------------------------------------------ *
 * Event -> document
 * ------------------------------------------------------------------ */

const MESSAGE_ROLES = new Map([
  ['user/message', 'user'],
  ['assistant/message', 'assistant'],
  ['tool/result', 'tool'],
  ['developer/message', 'developer'],
  ['system/message', 'system'],
])

const blocksText = (blocks) => {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool-call') parts.push(`[tool-call:${block.name ?? '?'}]`)
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'file') parts.push(`[file:${block.attachment?.name ?? '?'}]`)
    // Reasoning blocks are intentionally dropped: they are not conversation content.
  }
  return parts.join('\n')
}

// Event data is either the message itself (`user/message`) or `{message, stream}`
// (`assistant/message`, `tool/result`).
const contentOf = (data) => {
  if (!data || typeof data !== 'object') return ''
  const message = data.message && typeof data.message === 'object' ? data.message : data
  return blocksText(message.content)
}

const docOf = (event) => {
  if (!event || typeof event !== 'object') return undefined
  const role = MESSAGE_ROLES.get(event.type)
  if (!role) return undefined
  return { seq: event.seq, time: event.time, type: event.type, role, text: contentOf(event.data) }
}

const titleOfEvents = (events) => {
  let title
  for (const event of events) {
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') {
      if (title === undefined || event.seq > 0) title = event.data.title
    }
  }
  return title
}

const headerOfEvents = (events) => {
  for (const event of events) if (event?.type === 'session') return event
  return undefined
}

/* ------------------------------------------------------------------ *
 * Disk fallback
 * ------------------------------------------------------------------ */

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const zstdReady = () => typeof zlib.zstdDecompressSync === 'function'

// One zstd stream per append, concatenated in the file. Decompress frame by frame:
// walk the magic offsets and greedily extend the end offset until a frame decodes.
const decodeZstdFrames = (buffer) => {
  const starts = []
  let cursor = 0
  while ((cursor = buffer.indexOf(ZSTD_MAGIC, cursor)) !== -1) {
    starts.push(cursor)
    cursor += 4
  }
  if (starts.length === 0) return ''
  const parts = []
  let index = 0
  let guard = 0
  while (index < starts.length && guard++ < 20000) {
    let next = -1
    const upper = Math.min(index + 8, starts.length)
    for (let probe = index + 1; probe < upper; probe += 1) {
      try {
        parts.push(zlib.zstdDecompressSync(buffer.subarray(starts[index], starts[probe])).toString('utf8'))
        next = probe
        break
      } catch {}
    }
    if (next === -1) {
      try {
        parts.push(zlib.zstdDecompressSync(buffer.subarray(starts[index])).toString('utf8'))
        next = starts.length
      } catch {
        break
      }
    }
    index = next
  }
  return parts.join('')
}

const parseJsonl = (content) => {
  const events = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A torn tail line is normal for an appended log; skip it.
    }
  }
  return events
}

const sessionsRoot = () => join(homedir(), '.dsh', 'sessions')

const diskReadSession = async (file) => {
  const buffer = await fsp.readFile(file)
  const events = parseJsonl(decodeZstdFrames(buffer))
  if (events.length === 0) throw failure('unavailable', 'empty or undecodable session log')
  const header = headerOfEvents(events)
  return { header, events }
}

// Cheap header read: decode only the first frame of the file.
const diskHeaderOnly = async (file) => {
  const handle = await fsp.open(file, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, 65536)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, 0)
    const firstEnd = (() => {
      const second = buffer.indexOf(ZSTD_MAGIC, 4)
      return second === -1 ? length : second
    })()
    let content
    try {
      content = zlib.zstdDecompressSync(buffer.subarray(0, firstEnd)).toString('utf8')
    } catch {
      content = decodeZstdFrames(buffer).split('\n')[0] ?? ''
    }
    const events = parseJsonl(content)
    return { header: headerOfEvents(events), title: titleOfEvents(events) }
  } finally {
    await handle.close()
  }
}

const diskCorpus = async () => {
  if (!zstdReady()) throw failure('unavailable', 'node:zlib has no zstd support (needs Node >= 22.15)')
  const root = sessionsRoot()
  const entries = []
  let slugs
  try {
    slugs = await fsp.readdir(root, { withFileTypes: true })
  } catch (error) {
    throw failure('unavailable', `no sessions directory at ${root}: ${error?.message ?? error}`)
  }
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    const slugDir = join(root, slug.name)
    let ids
    try {
      ids = await fsp.readdir(slugDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const id of ids) {
      if (!id.isDirectory()) continue
      const file = join(slugDir, id.name, 'session.v4.jsonl.zstd')
      try {
        const stat = await fsp.stat(file)
        entries.push({ id: id.name, file, mtime: stat.mtimeMs, bytes: stat.size, slug: slug.name })
      } catch {}
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime)
  return entries
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

export function apply(ctx, config = {}) {
  const settings = { maxBytes: MAX_BYTES, ...config }

  // Obtained lazily: the service is optional, so a Host without it still loads.
  const service = () => {
    try {
      return ctx.get('sessionQuery')
    } catch {
      return undefined
    }
  }

  const cache = new Map()

  const remember = (id, entry) => {
    cache.set(id, entry)
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value
      cache.delete(oldest)
    }
  }

  const cached = (id) => {
    const hit = cache.get(id)
    if (!hit) return undefined
    if (Date.now() - hit.at > CACHE_TTL_MS) {
      cache.delete(id)
      return undefined
    }
    return hit
  }

  const loadViaService = async (query, id) => {
    const snapshot = await query.readSession(id)
    const events = Array.isArray(snapshot?.events) ? snapshot.events : []
    const docs = events.map(docOf).filter(Boolean)
    return {
      source: 'sessionQuery',
      header: snapshot?.session ?? headerOfEvents(events),
      title: titleOfEvents(events),
      docs,
      events,
    }
  }

  const loadViaDisk = async (id, file) => {
    const target = file ?? (await resolveDiskFile(id))
    if (!target) throw failure('not-found', `session ${shortId(id)} not found on disk`)
    const { header, events } = await diskReadSession(target)
    const docs = events.map(docOf).filter(Boolean)
    return { source: 'disk', header, title: titleOfEvents(events), docs, events }
  }

  const resolveDiskFile = async (id) => {
    const corpus = await diskCorpus()
    const exact = corpus.find((entry) => entry.id === id)
    return exact?.file
  }

  // One session's conversation, from cache, the service, or the disk — in that order.
  // A service that answers but fails for this one session falls through to the disk
  // instead of failing the whole call.
  const load = async (id) => {
    const hit = cached(id)
    if (hit) return hit
    const query = service()
    let serviceError
    if (query && typeof query.readSession === 'function') {
      try {
        const loaded = await loadViaService(query, id)
        remember(id, { ...loaded, at: Date.now() })
        return loaded
      } catch (error) {
        serviceError = error
      }
    }
    try {
      const loaded = await loadViaDisk(id)
      remember(id, { ...loaded, at: Date.now() })
      return loaded
    } catch (diskError) {
      const detail = `sessionQuery: ${serviceError?.message ?? 'not available'}; disk: ${diskError?.message ?? diskError}`
      const code = diskError?.code === 'unavailable' ? 'unavailable' : 'not-found'
      throw failure(code, `cannot read session ${shortId(id)} (${detail})`)
    }
  }

  const recordOfService = async (query) => {
    const records = await query.listSessions()
    return (Array.isArray(records) ? records : []).map((record) => ({
      id: record?.header?.id,
      header: record?.header,
      live: record?.live === true,
      persisted: record?.persisted === true,
      updatedAt: record?.header?.createdAt,
      title: undefined,
      messages: undefined,
    }))
  }

  const recordOfDisk = async () => {
    const corpus = await diskCorpus()
    const out = []
    for (const entry of corpus) {
      let header
      let title
      try {
        const info = await diskHeaderOnly(entry.file)
        header = info.header
        title = info.title
      } catch {}
      out.push({
        id: entry.id,
        header,
        live: false,
        persisted: true,
        updatedAt: entry.mtime,
        title,
        messages: undefined,
        file: entry.file,
      })
    }
    return out
  }

  const corpus = async () => {
    const query = service()
    if (query && typeof query.listSessions === 'function') {
      try {
        const records = await recordOfService(query)
        if (records.length > 0) return { source: 'sessionQuery', records }
      } catch {}
    }
    const records = await recordOfDisk()
    return { source: 'disk', records }
  }

  // `session` accepts an exact id, a `session-<id>` form, or any unique prefix of either
  // (what `list` prints is the 8-char short id).
  const resolveSession = async (needle) => {
    const raw = String(needle ?? '').trim()
    if (!raw) throw failure('bad-request', 'session is required')
    const wanted = bareId(raw)
    const { source, records } = await corpus()
    const exact = records.find((record) => record.id === raw || bareId(record.id) === wanted)
    if (exact) return { source, record: exact }
    const matches = records.filter((record) => {
      const bare = bareId(record.id)
      return typeof bare === 'string' && bare.startsWith(wanted)
    })
    if (matches.length === 1) return { source, record: matches[0] }
    if (matches.length > 1) {
      throw failure('ambiguous', `session prefix "${raw}" matches ${matches.length} sessions: ${matches.map((m) => shortId(m.id)).join(', ')}`)
    }
    throw failure('not-found', `no session matches "${raw}"`)
  }

  // Message count and last activity for one session, cheaply when the service allows it.
  const countOf = async (record) => {
    const query = service()
    if (query && typeof query.listEvents === 'function') {
      try {
        const events = await query.listEvents(record.id)
        const list = Array.isArray(events) ? events : []
        if (list.length > 0) {
          let messages = 0
          let last = 0
          for (const event of list) {
            if (MESSAGE_ROLES.has(event?.type)) messages += 1
            if (Number.isFinite(event?.time) && event.time > last) last = event.time
          }
          return { messages, updatedAt: last || undefined }
        }
      } catch {}
    }
    try {
      const loaded = await load(record.id)
      let messages = 0
      let last = 0
      for (const doc of loaded.docs) {
        messages += 1
        if (Number.isFinite(doc.time) && doc.time > last) last = doc.time
      }
      return { messages, updatedAt: last || undefined, title: loaded.title }
    } catch {
      return {}
    }
  }

  /* ---------------------------- actions ---------------------------- */

  const actionList = async (args) => {
    const limit = clampLimit(args.limit, 10, MAX_LIMIT)
    const { source, records } = await corpus()
    // Titles come from a batch call when the service offers one; message counts stay
    // undefined rather than reading every log, and are filled in only for what we print.
    const query = service()
    const titles = new Map()
    if (source === 'sessionQuery' && query && typeof query.readTitleSnapshots === 'function') {
      const ids = records.slice(0, limit).map((record) => record.id).filter(Boolean)
      try {
        const snapshots = await query.readTitleSnapshots(ids)
        for (const entry of Array.isArray(snapshots) ? snapshots : []) {
          if (entry?.status === 'fulfilled' && entry.value?.title?.title) titles.set(entry.sessionId, entry.value.title.title)
        }
      } catch {}
    }

    const rows = []
    for (const record of records.slice(0, limit)) {
      const id = record.id
      const info = await countOf(record)
      rows.push({
        id: shortId(id),
        title: record.title ?? info.title ?? titles.get(id),
        created: iso(record.header?.createdAt),
        updated: iso(info.updatedAt ?? record.updatedAt),
        preset: record.header?.agentPreset,
        messages: info.messages,
        cwd: record.header?.cwd,
        live: record.live,
        origin: record.header?.origin,
        parent: record.header?.parentSession ? shortId(record.header.parentSession) : undefined,
      })
    }
    return fit({ action: 'list', source, total: records.length, sessions: rows }, 'sessions', 0, settings.maxBytes)
  }

  const actionSearch = async (args) => {
    const needle = String(args.query ?? '').trim()
    if (!needle) throw new Error('query is required for search')
    const limit = clampLimit(args.limit, 10, MAX_LIMIT)
    const lowered = needle.toLowerCase()

    let targets
    let source
    if (args.session) {
      const { source: resolvedSource, record } = await resolveSession(args.session)
      source = resolvedSource
      targets = [record]
    } else {
      const result = await corpus()
      source = result.source
      targets = result.records
    }

    const hits = []
    let scanned = 0
    let sessionsMatched = 0
    for (const record of targets.slice(0, MAX_SCAN_SESSIONS)) {
      scanned += 1
      let loaded
      try {
        loaded = await load(record.id)
      } catch {
        continue
      }
      let matchedHere = false
      for (const doc of loaded.docs) {
        if (!doc.text) continue
        const at = doc.text.toLowerCase().indexOf(lowered)
        if (at === -1) continue
        matchedHere = true
        hits.push({
          session: shortId(record.id),
          title: loaded.title ?? record.title,
          seq: doc.seq,
          time: iso(doc.time),
          role: doc.role,
          snippet: snippet(doc.text, at, needle.length),
          at,
        })
        if (hits.length >= limit * 4) break
      }
      if (matchedHere) sessionsMatched += 1
      if (hits.length >= limit * 4) break
    }

    const kept = hits.slice(0, limit)
    return fit(
      { action: 'search', source, query: needle, mode: 'literal-substring', scanned, sessionsMatched, hits: kept, matchedEvents: hits.length },
      'hits',
      0,
      settings.maxBytes,
    )
  }

  const actionRead = async (args) => {
    const { source, record } = await resolveSession(args.session)
    const loaded = await load(record.id)
    const roles = parseRoles(args.role)
    const all = loaded.docs.filter((doc) => !roles || roles.has(doc.role))

    // Three windows: an explicit seq range, a backward page ("offset:N" = how many of the
    // newest messages this caller already saw), or the default tail.
    const window = parseWindow(args.window)
    const limit = clampLimit(args.limit, 20, MAX_READ_MESSAGES)
    let docs = all
    let offset = 0
    if (window.kind === 'seq') {
      docs = all.filter((doc) => doc.seq >= window.from && doc.seq <= window.to)
    } else {
      if (window.kind === 'offset') {
        offset = window.offset
        docs = all.slice(0, Math.max(0, all.length - offset))
      }
      docs = docs.slice(-limit)
    }

    const messages = docs.map((doc) => {
      const truncated = doc.text.length > MAX_MESSAGE_CHARS
      return {
        seq: doc.seq,
        time: iso(doc.time),
        role: doc.role,
        text: truncated ? doc.text.slice(0, MAX_MESSAGE_CHARS) : doc.text,
        ...(truncated ? { textTruncated: true, fullChars: doc.text.length } : {}),
      }
    })

    return fit(
      {
        action: 'read',
        session: shortId(record.id),
        title: loaded.title,
        source,
        preset: loaded.header?.agentPreset,
        totalMessages: all.length,
        window: args.window ?? `tail:${limit}`,
        messages,
      },
      'messages',
      offset,
      settings.maxBytes,
    )
  }

  /* ---------------------------- helpers ---------------------------- */

  const snippet = (haystack, at, length) => {
    const start = Math.max(0, at - SNIPPET_PAD)
    const end = Math.min(haystack.length, at + length + SNIPPET_PAD)
    const body = haystack.slice(start, end).replace(/\s+/g, ' ')
    return `${start > 0 ? '…' : ''}${body}${end < haystack.length ? '…' : ''}`
  }

  const clampLimit = (value, fallback, max) => {
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) return fallback
    return Math.min(Math.floor(number), max)
  }

  const parseRoles = (value) => {
    if (value === undefined || value === null || value === '') return undefined
    const list = (Array.isArray(value) ? value : String(value).split(',')).map((item) => String(item).trim().toLowerCase()).filter(Boolean)
    if (list.length === 0 || list.includes('all')) return undefined
    return new Set(list)
  }

  // `window` has two documented forms: "120-180" (seq range) and "offset:N" (cursor).
  const parseWindow = (value) => {
    if (value === undefined || value === null || value === '') return { kind: 'tail' }
    const raw = String(value).trim()
    const offset = /^offset:(\d+)$/i.exec(raw)
    if (offset) return { kind: 'offset', offset: Number(offset[1]) }
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(raw)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      return { kind: 'seq', from: Math.min(from, to), to: Math.max(from, to) }
    }
    const single = /^(\d+)$/.exec(raw)
    if (single) return { kind: 'seq', from: Number(single[1]), to: Number(single[1]) }
    return { kind: 'tail' }
  }

  // `unavailable` is reserved for "neither data source works"; a bad argument is a normal
  // error result, not a missing data source.
  const unavailable = (action, error) => ({
    action,
    unavailable: true,
    reason: String(error?.message ?? error ?? 'unknown'),
    tried: ['sessionQuery', join('~', '.dsh', 'sessions')],
  })

  const failed = (action, error) => ({
    action,
    error: {
      code: error?.code ?? 'error',
      message: String(error?.message ?? error ?? 'unknown'),
    },
  })

  /* ----------------------------- tool ------------------------------ */

  const tool = {
    name: 'session_reader',
    description:
      'Read-only access to other DSH sessions. list: recent sessions (short id, title, updated, preset, message count). '
      + 'search: literal substring across sessions (CJK-safe, ASCII case-insensitive) with snippet + event seq; '
      + 'pass session to search one. read: full conversation from the raw log, not the compacted model view; '
      + 'long messages are truncated. Use a short id from list.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'read'], description: 'What to do.' },
        session: { type: 'string', description: 'Session id or unique prefix. Required for read; optional filter for search.' },
        query: { type: 'string', description: 'Literal text to find. Required for search.' },
        limit: { type: 'number', description: 'list/search: rows, default 10, max 30. read: trailing messages, default 20, max 60.' },
        window: { type: 'string', description: 'read: "120-180" = event seq range. Any action: "offset:N" = resume from nextCursor.' },
        role: { type: 'string', description: 'read: comma-separated roles to keep (user, assistant, tool, system, developer). Default all.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => text(value),
    },
    async execute(args) {
      const action = String(args?.action ?? '')
      try {
        if (action === 'list') return clean(await actionList(args ?? {}))
        if (action === 'search') return clean(await actionSearch(args ?? {}))
        if (action === 'read') return clean(await actionRead(args ?? {}))
        return clean(failed(action, failure('bad-request', `unknown action: ${action || '(missing)'}; use list, search or read`)))
      } catch (error) {
        return clean(error?.code === 'unavailable' ? unavailable(action, error) : failed(action, error))
      }
    },
  }

  ctx.effect(() => {
    const dispose = ctx.tools.register(tool)
    return () => {
      cache.clear()
      dispose()
    }
  })
}
