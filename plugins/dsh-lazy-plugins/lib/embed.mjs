/**
 * Local Chinese encoder: BERT WordPiece tokenizer + ONNX inference + mean pooling.
 *
 * Why hand-written: the alternative is `@huggingface/transformers` (a large JS stack) for one
 * 24 MB model. The tokenizer here follows BERT's rules that matter for Chinese — lowercase,
 * per-character CJK splitting, greedy longest-match WordPiece — which is what bge-small-zh was
 * trained with. It is deliberately small and auditable.
 */
import { readFileSync, existsSync } from 'node:fs'

export const loadVocab = (path) => {
  const text = readFileSync(path, 'utf8')
  const map = new Map()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const token = lines[i].replace(/\r$/, '')
    if (token === '') continue
    map.set(token, i)
  }
  return map
}

const isCjk = (ch) => {
  const code = ch.codePointAt(0)
  return (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0xf900 && code <= 0xfaff)
}

const isPunct = (ch) => /[!-/:-@[-`{-~\u3000-\u303f\uff00-\uffef]/.test(ch)
const isSpace = (ch) => /\s/.test(ch)

// BERT basic tokenizer: lowercase, split CJK per character, split punctuation, strip control chars.
export const basicTokenize = (text) => {
  const out = []
  let word = ''
  const flush = () => {
    if (word) {
      out.push(word.toLowerCase())
      word = ''
    }
  }
  for (const ch of String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')) {
    if (isSpace(ch)) {
      flush()
      continue
    }
    if (isCjk(ch) || isPunct(ch)) {
      flush()
      out.push(ch)
      continue
    }
    word += ch
  }
  flush()
  return out
}

export const wordPiece = (token, vocab) => {
  const unk = vocab.get('[UNK]') ?? 100
  if (vocab.has(token)) return [vocab.get(token)]
  const pieces = []
  let start = 0
  while (start < token.length) {
    let end = token.length
    let matched
    while (start < end) {
      const piece = (start > 0 ? '##' : '') + token.slice(start, end)
      if (vocab.has(piece)) {
        matched = piece
        break
      }
      end -= 1
    }
    if (!matched) return [unk]
    pieces.push(vocab.get(matched))
    start = end
  }
  return pieces.slice(0, 32)
}

export const encode = (text, vocab, maxLength = 256) => {
  const ids = [vocab.get('[CLS]') ?? 101]
  for (const word of basicTokenize(text)) {
    for (const id of wordPiece(word, vocab)) {
      if (ids.length >= maxLength - 1) break
      ids.push(id)
    }
    if (ids.length >= maxLength - 1) break
  }
  ids.push(vocab.get('[SEP]') ?? 102)
  return ids
}

// Mean pooling over the token axis with the attention mask, then L2 normalisation — the pooling
// sentence-transformers uses for bge models.
export const pool = (hidden, dims, length) => {
  const out = new Float32Array(dims)
  for (let token = 0; token < length; token += 1) {
    const base = token * dims
    for (let d = 0; d < dims; d += 1) out[d] += hidden[base + d]
  }
  let norm = 0
  for (let d = 0; d < dims; d += 1) {
    out[d] /= length || 1
    norm += out[d] * out[d]
  }
  norm = Math.sqrt(norm) || 1
  for (let d = 0; d < dims; d += 1) out[d] /= norm
  return out
}

export const cosine = (a, b) => {
  let dot = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) dot += a[i] * b[i]
  return dot
}

/**
 * Lazily create the ONNX session. Returns undefined when the runtime or the model is missing, so
 * every caller keeps its fallback instead of throwing.
 */
export const createEncoder = async (modelPath, vocabPath) => {
  if (!existsSync(modelPath) || !existsSync(vocabPath)) return undefined
  let ort
  try {
    ort = await import('onnxruntime-node')
  } catch {
    return undefined
  }
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] })
  const vocab = loadVocab(vocabPath)
  const inputs = session.inputNames
  const useTokenTypes = inputs.includes('token_type_ids')

  const embedOne = async (text) => {
    const ids = encode(text, vocab, 256)
    const len = ids.length
    const shape = [1, len]
    const feeds = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map((id) => BigInt(id))), shape),
      attention_mask: new ort.Tensor('int64', BigInt64Array.from(ids.map(() => 1n)), shape),
    }
    if (useTokenTypes) feeds.token_type_ids = new ort.Tensor('int64', BigInt64Array.from(ids.map(() => 0n)), shape)
    const output = await session.run(feeds)
    const first = output[session.outputNames[0]]
    const dims = first.dims[2]
    const data = first.data instanceof Float32Array ? first.data : Float32Array.from(first.data)
    return pool(data, dims, len)
  }

  const embedMany = async (texts, batchSize = 16) => {
    const out = []
    for (let i = 0; i < texts.length; i += batchSize) {
      const slice = texts.slice(i, i + batchSize)
      for (const text of slice) out.push(await embedOne(text))
    }
    return out
  }

  return { embedOne, embedMany, dims: session.outputMetadata?.dims?.[2], inputs, session }
}
