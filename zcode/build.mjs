#!/usr/bin/env node
/**
 * Build the ZCode plugin registry snapshot.
 *
 * Sources (all local, nothing is fetched by this script):
 *   - `zcode plugins list --json --available`  → the catalogue (2571 rows) + installed state
 *   - ~/.zcode/cli/plugins/marketplaces/<m>/marketplace.json → version, source, i18n text,
 *     category, keywords, sha256
 *   - ~/.zcode/cli/config.json (+ optional project config)  → enabled flags
 *   - the source scan from the plugin-on-demand skill → risk flags and local-path presence
 *
 * Output is committed, because CI has no ZCode installation to re-derive it:
 *   zcode/site/index.html   self-contained (inline CSS/JS/data, opens from file://)
 *   zcode/site/catalog.json machine-readable mirror
 *   zcode/site/stats.json   counts used by the sources section
 *
 *   node zcode/build.mjs [--out zcode/site]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const HOME = os.homedir();
const MARKET_ROOT = path.join(HOME, '.zcode', 'cli', 'plugins', 'marketplaces');
const KNOWN = path.join(HOME, '.zcode', 'cli', 'plugins', 'known_marketplaces.json');
const USER_CFG = path.join(HOME, '.zcode', 'cli', 'config.json');
const CLI = process.env.ZCODE_CLI || 'C:/DDDD/app/ZCode/resources/glm/zcode.cjs';
const SKILL_CACHE = process.env.PLUGIN_ONDEMAND_CACHE || 'C:/DDDD/Agent Work/.agents/skills/plugin-on-demand/.cache';
const PROJECT_CFG = process.env.ZCODE_PROJECT_CONFIG || 'C:/DDDD/Agent Work/.zcode/config.json';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const OUT = path.resolve(REPO, outAt >= 0 ? args[outAt + 1] : 'zcode/site');

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

const catalog = (() => {
  const raw = execFileSync(process.execPath, [CLI, 'plugins', 'list', '--json', '--available'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000,
  });
  return JSON.parse(raw);
})();

const installed = new Map(((catalog.installed) || []).map((p) => [p.id, p]));
const available = (catalog.available || []).slice();

// enabled state: user layer, then project layer wins
const enabledMap = { ...((readJson(USER_CFG, {}) || {}).plugins?.enabledPlugins || {}) };
const proj = readJson(PROJECT_CFG, null);
if (proj && proj.plugins && proj.plugins.enabledPlugins) Object.assign(enabledMap, proj.plugins.enabledPlugins);

// ---- marketplace manifests ------------------------------------------------
const MANIFESTS = ['marketplace.json', path.join('.claude-plugin', 'marketplace.json'), path.join('.zcode-plugin', 'marketplace.json')];
const markets = [];
const pluginIndex = new Map(); // `${name}@${market}` -> manifest entry

for (const id of fs.existsSync(MARKET_ROOT) ? fs.readdirSync(MARKET_ROOT).filter((d) => fs.statSync(path.join(MARKET_ROOT, d)).isDirectory()) : []) {
  const root = path.join(MARKET_ROOT, id);
  const mf = MANIFESTS.map((m) => path.join(root, m)).find(exists);
  if (!mf) continue;
  const j = readJson(mf, {}) || {};
  const entries = j.plugins || j.entries || [];
  const kinds = {};
  for (const p of entries) {
    const src = classify(p.source);
    kinds[src.kind] = (kinds[src.kind] || 0) + 1;
    pluginIndex.set(`${p.name}@${id}`, { ...p, _root: root, _spec: src });
  }
  const stat = fs.statSync(mf);
  markets.push({
    id,
    count: entries.length,
    kinds,
    cacheAgeDays: Math.round(((Date.now() - stat.mtimeMs) / 86400000) * 10) / 10,
  });
}

function classify(src) {
  if (typeof src === 'string') {
    if (src === 'filesystem') return { kind: 'builtin' };
    return /^[a-z]+:\/\//i.test(src) ? { kind: 'url', url: src } : { kind: 'path', path: src };
  }
  if (!src || typeof src !== 'object') return { kind: 'unknown' };
  const url = src.url || (src.repo ? `https://github.com/${src.repo}` : '');
  if (src.source === 'url') {
    const zip = src.type === 'zip' || /\.zip(\?|$)/i.test(String(src.url || ''));
    return { kind: zip ? 'zip' : 'git', url, sha: src.sha256 || src.sha || null, ref: src.ref || null };
  }
  if (src.source === 'github') return { kind: 'github', url, sha: src.sha || null, ref: src.ref || null };
  return { kind: String(src.source || 'other'), url, sha: src.sha || null, ref: src.ref || null, path: src.path || null };
}

const RISK_FILES = [
  ['hooks', ['hooks/hooks.json', 'hooks.json', '.claude-plugin/hooks.json']],
  ['mcp', ['.mcp.json', 'mcp.json']],
  ['lsp', ['.lsp.json', 'lsp.json']],
];
const riskOf = (dir) => {
  const out = [];
  for (const [tag, files] of RISK_FILES) if (files.some((f) => exists(path.join(dir, f)))) out.push(tag);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const k of ['preinstall', 'install', 'postinstall']) if (pkg.scripts && pkg.scripts[k]) out.push('npm');
  } catch {}
  return [...new Set(out)];
};

// host reachability measured by the plugin-on-demand skill (10 min cache)
const health = readJson(path.join(SKILL_CACHE, 'host-health.json'), {}) || {};
const hostState = (url) => {
  let host = null;
  try { host = new URL(url).hostname; } catch { return { host: null, ok: null }; }
  const h = health[host];
  return { host, ok: h ? !!h.ok : null };
};

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const rows = [];
const seen = new Set();
for (const p of available) {
  const id = p.id;
  const at = id.lastIndexOf('@');
  const name = at >= 0 ? id.slice(0, at) : id;
  const market = at >= 0 ? id.slice(at + 1) : '';
  const man = pluginIndex.get(id);
  const spec = man ? man._spec : { kind: 'unknown' };
  let localPresent = false;
  if (spec.kind === 'path' && man && man._root) {
    const dir = path.resolve(man._root, spec.path);
    localPresent = dir.startsWith(man._root) && exists(dir);
    if (localPresent) spec._dir = dir;
  }
  const risk = spec._dir ? riskOf(spec._dir) : [];
  const zh = man && man.description_i18n && (man.description_i18n['zh-CN'] || man.description_i18n.zh);
  const en = man && man.description_i18n && (man.description_i18n.en || man.description_i18n['en-US']);
  const inst = installed.get(id);
  const builtin = spec.kind === 'builtin' || market === 'builtin';
  const hs = spec.kind === 'path' || spec.kind === 'builtin'
    ? { host: null, ok: true }
    : spec.url ? hostState(spec.url) : { host: null, ok: null };
  const installable = spec.kind === 'path' || spec.kind === 'builtin'
    ? (builtin || localPresent ? 'ready' : 'missing')
    : (hs.ok === true ? 'ready' : hs.ok === false ? 'blocked' : 'unknown');
  rows.push({
    id,
    n: name,
    m: market,
    v: (man && man.version) || p.version || null,
    d: clip(zh || man?.description || p.description || inst?.description || '', 240),
    de: clip(en || man?.description || p.description || '', 240),
    cat: (man && man.category) || null,
    kw: (man && Array.isArray(man.keywords) ? man.keywords.slice(0, 8) : []),
    k: spec.kind,
    sha: spec.sha ? String(spec.sha).slice(0, 12) : null,
    host: hs.host,
    l: localPresent ? 1 : 0,
    r: risk,
    b: builtin ? 1 : 0,
    i: inst ? 1 : 0,
    e: inst ? (Object.prototype.hasOwnProperty.call(enabledMap, id) ? (enabledMap[id] ? 1 : 0) : (inst.enabled ? 1 : 0)) : 0,
    c: inst ? [Number(inst.skillCount) || 0, Number(inst.commandRootCount) || 0, (inst.mcpServerNames || []).length, (inst.hookDetails || []).length] : null,
    x: inst && inst.diagnostics && inst.diagnostics.length ? inst.diagnostics.length : 0,
    a: installable,
  });
  seen.add(id);
}

// installed rows that the marketplace catalogue no longer lists (kept, clearly marked)
for (const [id, inst] of installed) {
  if (seen.has(id)) continue;
  rows.push({
    id, n: inst.name, m: inst.marketplace, v: inst.version || null,
    d: clip(inst.description || '', 240), de: clip(inst.description || '', 240),
    cat: null, kw: [], k: 'local', sha: null, host: null, l: 1, r: [], b: id.endsWith('@builtin') ? 1 : 0,
    i: 1, e: inst.enabled ? 1 : 0,
    c: [Number(inst.skillCount) || 0, Number(inst.commandRootCount) || 0, (inst.mcpServerNames || []).length, (inst.hookDetails || []).length],
    x: (inst.diagnostics || []).length, a: 'ready',
  });
}

rows.sort((a, b) => a.n.localeCompare(b.n) || a.m.localeCompare(b.m));

const by = (f) => rows.reduce((acc, r) => { const k = f(r); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
const stats = {
  generatedAt: new Date().toISOString(),
  total: rows.length,
  installed: rows.filter((r) => r.i).length,
  enabled: rows.filter((r) => r.e).length,
  builtin: rows.filter((r) => r.b).length,
  risk: rows.filter((r) => r.r.length).length,
  withSha: rows.filter((r) => r.sha).length,
  markets: markets.sort((a, b) => b.count - a.count).map((m) => ({
    ...m,
    onDisk: true,
    rowCount: rows.filter((r) => r.m === m.id).length,
    installed: rows.filter((r) => r.m === m.id && r.i).length,
    risk: rows.filter((r) => r.m === m.id && r.r.length).length,
    blocked: rows.filter((r) => r.m === m.id && r.a === 'blocked').length,
    ready: rows.filter((r) => r.m === m.id && r.a === 'ready').length,
  })),
  sourceKinds: by((r) => r.k),
  installable: by((r) => r.a),
  hosts: [...new Set(rows.map((r) => r.host).filter(Boolean))].map((h) => ({ host: h, ok: health[h] ? !!health[h].ok : null })),
  known: (readJson(KNOWN, {}) || {}).marketplaces || [],
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'catalog.json'), JSON.stringify({ generatedAt: stats.generatedAt, stats, plugins: rows }), 'utf8');
fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify(stats, null, 2) + '\n', 'utf8');

const template = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8');
const html = template
  .replace('/*__CATALOG__*/null', () => JSON.stringify(rows))
  .replace('/*__STATS__*/null', () => JSON.stringify(stats));
fs.writeFileSync(path.join(OUT, 'index.html'), html, 'utf8');

console.log(JSON.stringify({
  out: path.relative(REPO, OUT),
  rows: rows.length,
  bytes: fs.statSync(path.join(OUT, 'index.html')).size,
  installable: stats.installable,
  sourceKinds: stats.sourceKinds,
}, null, 1));
