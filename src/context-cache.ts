import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'

const MAX_CONTENT_CHARS = 5_000_000
const MAX_SUMMARY_CHARS = 200
const MAX_TOPIC_CHARS = 80
const MAX_TAGS = 10
const MAX_CACHE_ENTRIES = 10_000
const LRU_LIMIT = 64
const DEFAULT_INDEX_LIMIT = 100

export interface CacheEntry {
  id: string
  topic: string
  summary: string
  tags: string[]
  compressedSize: number
  originalSize: number
  createdAt: string
  updatedAt: string
}

interface CacheIndexData {
  entries: Record<string, CacheEntry>
}

export interface CacheSearchResult {
  id: string
  topic: string
  summary: string
  tags: string[]
  score: number
}

const now = (): string => new Date().toISOString()

function autoSummary(content: string): string {
  const lines = content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  const firstContentLine = lines.find((l) => !/^#{1,6}\s/.test(l)) ?? lines[0] ?? ''
  return firstContentLine.slice(0, MAX_SUMMARY_CHARS)
}

function autoTopic(content: string): string {
  const firstLine = content.split('\n').find((line) => line.trim().length > 0) ?? ''
  const heading = firstLine.match(/^#+\s*(.+)/)?.[1]
  return (heading ?? firstLine.trim() ?? 'untitled').slice(0, MAX_TOPIC_CHARS)
}

const EDGE_PUNCT = /^[.\-+#]+|[.\-+#]+$/g

function tokenize(text: string): string[] {
  const raw = text.toLocaleLowerCase().match(/[\p{L}\p{N}_+#.-]+/gu) ?? []
  const result: string[] = []
  for (const token of raw) {
    const stripped = token.replace(EDGE_PUNCT, '')
    if (stripped) {
      result.push(stripped)
      if (stripped !== token && /[#+]/.test(token)) result.push(token)
    } else if (token) {
      result.push(token)
    }
  }
  return result
}

function bm25Scores(query: string, corpus: string[]): number[] {
  const k1 = 1.5, b = 0.75
  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0 || corpus.length === 0) return corpus.map(() => 0)
  const docTokens = corpus.map((text) => tokenize(text))
  const docFreq = new Map<string, number>()
  for (const tokens of docTokens) {
    for (const term of new Set(tokens)) docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
  }
  const N = corpus.length
  const avgDl = docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / N
  return docTokens.map((tokens) => {
    const tf = new Map<string, number>()
    for (const term of tokens) tf.set(term, (tf.get(term) ?? 0) + 1)
    const dl = tokens.length
    let score = 0
    for (const term of queryTerms) {
      const df = docFreq.get(term) ?? 0
      if (df === 0) continue
      const f = tf.get(term) ?? 0
      if (f === 0) continue
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / avgDl))
    }
    return score
  })
}

export class ContextCache {
  private readonly chunksDir: string
  private readonly indexPath: string
  private entries: Record<string, CacheEntry> = {}
  private lru: Map<string, string> = new Map()

  constructor(storageDir: string) {
    this.chunksDir = join(storageDir, 'cache-chunks')
    this.indexPath = join(storageDir, 'cache-index.json')
    mkdirSync(this.chunksDir, { recursive: true })
    this.loadIndex()
  }

  private loadIndex(): void {
    try {
      const data = JSON.parse(readFileSync(this.indexPath, 'utf-8')) as CacheIndexData
      this.entries = data.entries ?? {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries = {}
        return
      }
      const corruptPath = `${this.indexPath}.corrupt-${Date.now()}`
      try { renameSync(this.indexPath, corruptPath) } catch { }
      process.stderr.write(`whimsicality-mcp: corrupt cache index renamed to ${corruptPath}; starting fresh\n`)
      this.entries = {}
    }
  }

  private chunkPath(id: string): string {
    return join(this.chunksDir, `${id}.br`)
  }

  private lruGet(id: string): string | undefined {
    const value = this.lru.get(id)
    if (value !== undefined) {
      this.lru.delete(id)
      this.lru.set(id, value)
    }
    return value
  }

  private lruSet(id: string, value: string): void {
    this.lru.set(id, value)
    while (this.lru.size > LRU_LIMIT) {
      const oldest = this.lru.keys().next().value
      if (oldest === undefined) break
      this.lru.delete(oldest)
    }
  }

  async store(id: string, content: string, topic: string, summary: string, tags: string[]): Promise<{ id: string; originalSize: number; compressedSize: number; ratio: number }> {
    if (content.length > MAX_CONTENT_CHARS) throw new Error(`content exceeds maximum length of ${MAX_CONTENT_CHARS}`)
    this.loadIndex()
    if (Object.keys(this.entries).length >= MAX_CACHE_ENTRIES && !(id in this.entries)) {
      throw new Error(`cache entry limit (${MAX_CACHE_ENTRIES}) reached`)
    }
    const compressed = brotliCompressSync(Buffer.from(content, 'utf-8'))
    const compressedSize = compressed.length
    const originalSize = Buffer.byteLength(content, 'utf-8')
    writeFileSync(this.chunkPath(id), compressed)
    const release = await lockfile.lock(this.indexPath, {
      realpath: false,
      stale: 10_000,
      retries: { retries: 8, factor: 1.5, minTimeout: 10, maxTimeout: 250, randomize: true },
    })
    try {
      this.loadIndex()
      const existing = this.entries[id]
      const entry: CacheEntry = {
        id,
        topic: topic || autoTopic(content),
        summary: summary || autoSummary(content),
        tags,
        compressedSize,
        originalSize,
        createdAt: existing?.createdAt ?? now(),
        updatedAt: now(),
      }
      const clone = { ...this.entries, [id]: entry }
      const temp = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(temp, JSON.stringify({ entries: clone }), 'utf-8')
      try { renameSync(temp, this.indexPath) } catch (error) { try { unlinkSync(temp) } catch { }; throw error }
      this.entries = clone
    } finally {
      await release()
    }
    this.lru.delete(id)
    return { id, originalSize, compressedSize, ratio: originalSize > 0 ? compressedSize / originalSize : 0 }
  }

  read(id: string): { content: string; entry: CacheEntry } | null {
    this.loadIndex()
    const entry = this.entries[id]
    if (!entry) return null
    const cached = this.lruGet(id)
    if (cached !== undefined) return { content: cached, entry }
    try {
      const compressed = readFileSync(this.chunkPath(id))
      const content = brotliDecompressSync(compressed).toString('utf-8')
      this.lruSet(id, content)
      return { content, entry }
    } catch {
      return null
    }
  }

  indexTable(topicFilter: string | null, limit: number): string {
    this.loadIndex()
    let entries = Object.values(this.entries)
    if (topicFilter) {
      const filter = topicFilter.toLocaleLowerCase()
      entries = entries.filter((e) => e.topic.toLocaleLowerCase().includes(filter) || e.tags.some((t) => t.includes(filter)))
    }
    entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const total = entries.length
    const shown = entries.slice(0, limit)
    if (shown.length === 0) return `## Context Cache (0 entries)\n(empty)`
    const lines = shown.map((e) => `| ${e.id} | ${e.topic} | ${e.summary} |`)
    const footer = total > shown.length ? `\n... and ${total - shown.length} more. Use whim_cache_search to find specific entries.` : ''
    return `## Context Cache (${total} entries, showing ${shown.length})\n| ID | Topic | Summary |\n|----|-------|---------|\n${lines.join('\n')}${footer}\n\nUse whim_cache_read with an ID to retrieve full content.`
  }

  search(query: string, topK: number): CacheSearchResult[] {
    this.loadIndex()
    const entries = Object.values(this.entries)
    if (entries.length === 0) return []
    const corpus = entries.map((e) => `${e.topic} ${e.summary} ${e.tags.join(' ')}`)
    const scores = bm25Scores(query, corpus)
    return entries
      .map((entry, i) => ({ id: entry.id, topic: entry.topic, summary: entry.summary, tags: entry.tags, score: scores[i] }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }

  list(): string[] {
    this.loadIndex()
    return Object.keys(this.entries).sort()
  }

  async delete(id: string): Promise<boolean> {
    const release = await lockfile.lock(this.indexPath, {
      realpath: false,
      stale: 10_000,
      retries: { retries: 8, factor: 1.5, minTimeout: 10, maxTimeout: 250, randomize: true },
    })
    try {
      this.loadIndex()
      const existed = id in this.entries
      if (!existed) return false
      const clone = { ...this.entries }
      delete clone[id]
      const temp = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(temp, JSON.stringify({ entries: clone }), 'utf-8')
      try { renameSync(temp, this.indexPath) } catch (error) { try { unlinkSync(temp) } catch { }; throw error }
      this.entries = clone
      try { unlinkSync(this.chunkPath(id)) } catch { }
      this.lru.delete(id)
      return true
    } finally {
      await release()
    }
  }

  stats(): { entries: number; totalOriginalBytes: number; totalCompressedBytes: number; ratio: number } {
    this.loadIndex()
    const all = Object.values(this.entries)
    const totalOriginal = all.reduce((sum, e) => sum + e.originalSize, 0)
    const totalCompressed = all.reduce((sum, e) => sum + e.compressedSize, 0)
    return {
      entries: all.length,
      totalOriginalBytes: totalOriginal,
      totalCompressedBytes: totalCompressed,
      ratio: totalOriginal > 0 ? totalCompressed / totalOriginal : 0,
    }
  }
}

export { MAX_CONTENT_CHARS, MAX_SUMMARY_CHARS, MAX_TOPIC_CHARS, MAX_TAGS, MAX_CACHE_ENTRIES, DEFAULT_INDEX_LIMIT }
