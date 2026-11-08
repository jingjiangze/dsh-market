// Derive Chinese display titles for the published catalogue.
//
// This runs as its own step, AFTER the other languages are filled in and after duplicate rows
// have been renamed, because a title can only come from Chinese text that exists at the time.
// It used to live inside crawl.mjs, which runs before translate.mjs fills `description.zh`
// from the cache — so every entry whose Chinese came from a translation kept an English title.
// Measured on the live document before the split: 13,380 entries carried Chinese text and only
// 4,532 had a Chinese title; 8,907 were stuck in exactly that gap.
//
//   node crawler/titles.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = join(root, 'dist', 'index.json')

const CJK = /[\u4e00-\u9fff]/

// A title is read at a glance in a list, so it is one clause: drop the "为 DSH 提供 …" opener
// every catalogue uses, prefer a comma boundary, and stop at a length that fits a card.
const TITLE_MAX = 20
const zhTitle = (text, fallback) => {
  let raw = String(text ?? '').replace(/\s+/g, ' ').trim()
  // Some catalogues prefix the blurb with their own figures ("★ 919 │ 限制 Mnemon 记忆…").
  raw = raw.replace(/^[★☆↓↑\s\d.,kKmM]+[│|·•]+\s*/, '').trim()
  if (!raw) return fallback
  raw = raw.replace(/^(为|给|让)\s*(DeepSeek\s*Harness|DSH|Harness)\s*(提供|实现|带来|增加|补上)?\s*/, '')
  const firstClause = raw.split(/[：:；;。!？\n]/)[0].trim()
  // A clause like "DSH 插件" carries no information once the generic words are removed, so
  // fall back to the full sentence and let the length rule below decide.
  const informative = (text) => text.replace(/DSH|dsh|插件|plugin|plugins|工具|拓展|扩展/g, '').replace(/[\s\-—:：·]/g, '').length >= 2
  let picked = firstClause.length >= 6 && informative(firstClause) ? firstClause : raw
  let cut = -1
  for (const match of picked.matchAll(/[，,、]/g)) {
    if (match.index >= 6 && match.index <= TITLE_MAX) cut = match.index
  }
  if (cut > 0) picked = picked.slice(0, cut)
  picked = picked.slice(0, TITLE_MAX)
  // Never end on a half word: "用本地 GP" reads as broken, "用本地" does not.
  picked = picked.replace(/[A-Za-z0-9]+$/, '').replace(/[，,、\-—\s…]+$|\.{2,}$/, '')
  // A 20-character window often closes right after a particle that was starting the next
  // phrase ("…工具以"). Dropping it reads as a finished clause instead.
  picked = picked.replace(/[以和与的在了为将用把及或对从把]$/, '').trim()
  picked = picked.replace(/[，,、\-—\s…]+$|\.{2,}$/, '')
  return picked || fallback
}

const index = JSON.parse(await readFile(INDEX, 'utf8'))
const plugins = index.plugins ?? []

let sawChinese = 0
let derived = 0
let alreadyHad = 0

for (const plugin of plugins) {
  const name = String(plugin.name ?? '')
  const desc = plugin.description
  const zhRaw = typeof desc === 'object' ? (desc.zh ?? '') : ''
  const enRaw = typeof desc === 'object' ? (desc.en ?? '') : (typeof desc === 'string' ? desc : '')
  // Most catalogues park their Chinese blurb under `en`; a Chinese title must come from
  // Chinese text, so take `zh` when it is Chinese and fall back to `en` when that is.
  const source = CJK.test(zhRaw) ? zhRaw : CJK.test(enRaw) ? enRaw : ''
  if (source) sawChinese++

  const title = typeof plugin.title === 'object' && plugin.title ? plugin.title : { en: String(plugin.title ?? name) }
  const titleEn = title.en || name
  const currentZh = title.zh ?? ''
  if (currentZh && CJK.test(currentZh) && currentZh !== name) { alreadyHad++; continue }
  if (!source) continue

  const candidate = zhTitle(source, name)
  if (!candidate || candidate === name || !CJK.test(candidate)) continue
  plugin.title = { ...title, en: titleEn, zh: candidate }
  derived++
}

await writeFile(INDEX, JSON.stringify(index) + '\n')
const pct = (n) => `${((n / Math.max(1, plugins.length)) * 100).toFixed(1)}%`
console.log(`titles: ${plugins.length} entries, ${sawChinese} carry Chinese text (${pct(sawChinese)}); `
  + `${alreadyHad} already titled, ${derived} derived; total ${alreadyHad + derived} (${pct(alreadyHad + derived)})`)
