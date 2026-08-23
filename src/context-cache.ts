import { createHash } from 'node:crypto'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'
import { bm25Scores } from './bm25.js'

const MAX_CONTENT_CHARS = 5_000_000
const MAX_SUMMARY_CHARS = 200
const MAX_TOPIC_CHARS = 80
const MAX_TAG_CHARS = 256
const MAX_TAGS = 10
const MAX_CACHE_ENTRIES = 10_000
const LRU_LIMIT = 64
const DEFAULT_INDEX_LIMIT = 100
const DEFAULT_READ_LENGTH = 8_000

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
  const lines = content.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  const heading = lines.find((l) => /^#{1,6}\s/.test(l))?.replace(/^#{1,6}\s*/, '')
  if (heading && heading.length > 0) return heading.slice(0, MAX_TOPIC_CHARS)
  const firstLine = lines[0]
  if (firstLine && firstLine.length > 0) return firstLine.slice(0, MAX_TOPIC_CHARS)
  return 'untitled'
}

function hashId(id: string): string {
  return createHash('sha256').update(id).digest('hex')
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export class ContextCache {
  private readonly chunksDir: string
  private readonly indexPath: string
  private entries: Record<string, CacheEntry> = {}
  private lru: Map<string, { content: string; updatedAt: string }> = new Map()

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

  private chunkPath(hashedId: string): string {
    return join(this.chunksDir, `${hashedId}.br`)
  }

  private lruGet(id: string, updatedAt: string): string | undefined {
    const cached = this.lru.get(id)
    if (cached === undefined) return undefined
    if (cached.updatedAt !== updatedAt) {
      this.lru.delete(id)
      return undefined
    }
    this.lru.delete(id)
    this.lru.set(id, cached)
    return cached.content
  }

  private lruSet(id: string, content: string, updatedAt: string): void {
    this.lru.set(id, { content, updatedAt })
    while (this.lru.size > LRU_LIMIT) {
      const oldest = this.lru.keys().next().value
      if (oldest === undefined) break
      this.lru.delete(oldest)
    }
  }

  async store(id: string, content: string, topic: string, summary: string, tags: string[]): Promise<{ id: string; originalSize: number; compressedSize: number; ratio: number }> {
    if (content.length > MAX_CONTENT_CHARS) throw new Error(`content exceeds maximum length of ${MAX_CONTENT_CHARS}`)
    const release = await lockfile.lock(this.indexPath, {
      realpath: false,
      stale: 10_000,
      retries: { retries: 8, factor: 1.5, minTimeout: 10, maxTimeout: 250, randomize: true },
    })
    try {
      this.loadIndex()
      if (Object.keys(this.entries).length >= MAX_CACHE_ENTRIES && !(id in this.entries)) {
        throw new Error(`cache entry limit (${MAX_CACHE_ENTRIES}) reached`)
      }
      const compressed = brotliCompressSync(Buffer.from(content, 'utf-8'))
      const compressedSize = compressed.length
      const originalSize = Buffer.byteLength(content, 'utf-8')
      const hashed = hashId(id)
      const chunkFile = this.chunkPath(hashed)
      const tempChunk = `${chunkFile}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tempChunk, compressed)
      try {
        const fd = openSync(tempChunk, 'r+')
        try { fsyncSync(fd) } catch { }
        closeSync(fd)
      } catch { }
      try { renameSync(tempChunk, chunkFile) } catch (error) { try { unlinkSync(tempChunk) } catch { }; throw error }

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
      const tempIndex = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(tempIndex, JSON.stringify({ entries: clone }), 'utf-8')
      try {
        const fd = openSync(tempIndex, 'r+')
        try { fsyncSync(fd) } catch { }
        closeSync(fd)
      } catch { }
      try { renameSync(tempIndex, this.indexPath) } catch (error) { try { unlinkSync(tempIndex) } catch { }; throw error }
      try {
        const dirFd = openSync(dirname(this.indexPath), 'r')
        try { fsyncSync(dirFd) } catch { }
        closeSync(dirFd)
      } catch { }
      this.entries = clone
      this.lru.delete(id)
      return { id, originalSize, compressedSize, ratio: originalSize > 0 ? compressedSize / originalSize : 0 }
    } finally {
      await release()
    }
  }

  read(id: string, offset: number, length: number): { content: string; entry: CacheEntry; offset: number; length: number; totalLength: number; hasMore: boolean } | null {
    this.loadIndex()
    const entry = this.entries[id]
    if (!entry) return null
    const cached = this.lruGet(id, entry.updatedAt)
    let fullContent: string
    if (cached !== undefined) {
      fullContent = cached
    } else {
      try {
        const compressed = readFileSync(this.chunkPath(hashId(id)))
        fullContent = brotliDecompressSync(compressed).toString('utf-8')
        this.lruSet(id, fullContent, entry.updatedAt)
      } catch {
        return null
      }
    }
    const totalLength = fullContent.length
    const start = Math.max(0, Math.min(offset, totalLength))
    const end = Math.min(start + length, totalLength)
    const content = fullContent.slice(start, end)
    return { content, entry, offset: start, length: content.length, totalLength, hasMore: end < totalLength }
  }

  indexTable(topicFilter: string | null, limit: number): string {
    this.loadIndex()
    let entries = Object.values(this.entries)
    if (topicFilter) {
      const filter = topicFilter.toLocaleLowerCase()
      entries = entries.filter((e) =>
        e.topic.toLocaleLowerCase().includes(filter) ||
        e.summary.toLocaleLowerCase().includes(filter) ||
        e.tags.some((t) => t.toLocaleLowerCase().includes(filter)),
      )
    }
    entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const total = entries.length
    const shown = entries.slice(0, limit)
    if (shown.length === 0) return `## Context Cache (0 entries)\n(empty)`
    const lines = shown.map((e) => `| ${e.id} | ${e.topic} | ${e.summary} |`)
    const tableText = `## Context Cache (${total} entries, showing ${shown.length})\n| ID | Topic | Summary |\n|----|-------|---------|\n${lines.join('\n')}`
    const approxTokens = estimateTokens(tableText)
    const footer = total > shown.length ? `\n... and ${total - shown.length} more. Use whim_cache_search to find specific entries.` : ''
    return `${tableText}${footer}\n\n~${approxTokens} tokens. Use whim_cache_read with an ID to retrieve content (supports offset+length for paging).`
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
      try { unlinkSync(this.chunkPath(hashId(id))) } catch { }
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

export { MAX_CONTENT_CHARS, MAX_SUMMARY_CHARS, MAX_TOPIC_CHARS, MAX_TAG_CHARS, MAX_TAGS, MAX_CACHE_ENTRIES, DEFAULT_INDEX_LIMIT, DEFAULT_READ_LENGTH }
