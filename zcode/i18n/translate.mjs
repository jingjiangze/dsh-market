#!/usr/bin/env node
/**
 * Fill missing Chinese descriptions with Google Translate (the public gtx endpoint the
 * translate.google.com page itself uses). Borrowed from dsh-market's crawler/translate.mjs:
 *
 *   - content-hash cache, so a string is translated once and never again;
 *   - a bounded pass (time + string count) because the first run has ~2.2k strings and the
 *     endpoint throttles;
 *   - a failure leaves the English text in place instead of publishing a broken string.
 *
 * This runs in CI (`.github/workflows/zcode-deploy.yml`), never in the page: the catalogue is
 * committed in English for community rows, and the deploy step fills zh then re-renders.
 *
 *   node zcode/i18n/translate.mjs                 # translate what is missing
 *   node zcode/i18n/translate.mjs --offline       # report only
 *   node zcode/i18n/translate.mjs --limit 5       # small batch (testing)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes('--' + name);

const INPUT = path.resolve(REPO, opt('input', 'zcode/site/catalog.json'));
const OUTPUT = path.resolve(REPO, opt('output', INPUT));
const CACHE = path.resolve(REPO, opt('cache', 'zcode/.i18n-cache.json'));
const OFFLINE = flag('offline');
const LIMIT = Number(opt('limit', 0)) || 0;
const CONCURRENCY = Number(process.env.TRANSLATE_CONCURRENCY || 16);
const BUDGET_MS = Number(process.env.TRANSLATE_BUDGET_MS || 8 * 60 * 1000);
const MAX_STRINGS = Number(process.env.TRANSLATE_MAX_STRINGS || 4000);
const CALL_TIMEOUT_MS = Number(process.env.TRANSLATE_TIMEOUT_MS || 8000);
// Overridable so the pass can be exercised against a local stub in tests.
const ENDPOINT = process.env.TRANSLATE_ENDPOINT || 'https://translate.googleapis.com/translate_a/single';

const CJK = /[\u3400-\u9fff]/;
const cache = (() => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')) || {}; } catch { return {}; } })();
const keyOf = (text) => `zh:${createHash('sha1').update(String(text)).digest('hex').slice(0, 16)}`;

const saveCache = () => {
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache), 'utf8');
};

const started = Date.now();
let attempted = 0;
let translated = 0;
let failed = 0;

async function translate(text) {
  const key = keyOf(text);
  if (cache[key]) return cache[key];
  if (OFFLINE) return null;
  attempted += 1;
  const url = `${ENDPOINT}?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 zcode-market' },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) { failed += 1; return null; }
      const body = await res.json();
      const out = (body?.[0] ?? []).map((part) => part?.[0] ?? '').join('').trim();
      if (!out) { failed += 1; return null; }
      cache[key] = out;
      translated += 1;
      if (translated % 50 === 0) saveCache();
      return out;
    } catch {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  failed += 1;
  return null;
}

const catalog = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
const plugins = Array.isArray(catalog.plugins) ? catalog.plugins : [];
const tasks = [];
for (const p of plugins) {
  const source = String(p.de || p.d || '').trim();
  if (!source || CJK.test(source)) continue;      // already Chinese somewhere in the source
  if (p.d && CJK.test(p.d)) continue;             // already translated
  tasks.push(p);
}
const queue = LIMIT ? tasks.slice(0, LIMIT) : tasks;
const stop = () => OFFLINE || Date.now() - started > BUDGET_MS || attempted >= MAX_STRINGS;

let cursor = 0;
async function worker() {
  while (cursor < queue.length && !stop()) {
    const p = queue[cursor++];
    const source = String(p.de || p.d || '').trim();
    const out = await translate(source);
    if (out) p.d = out;
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, worker));
saveCache();

const changed = !OFFLINE && translated > 0;
if (changed) {
  fs.writeFileSync(OUTPUT, JSON.stringify(catalog), 'utf8');
}

console.log(JSON.stringify({
  input: path.relative(REPO, INPUT),
  output: changed ? path.relative(REPO, OUTPUT) : null,
  candidates: tasks.length,
  queued: queue.length,
  attempted,
  translated,
  failed,
  cached: Object.keys(cache).length,
  offline: OFFLINE,
  stoppedByBudget: stop() && !OFFLINE,
  elapsedMs: Date.now() - started,
}, null, 1));
