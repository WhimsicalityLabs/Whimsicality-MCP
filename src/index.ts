#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'
import { ContextCache, DEFAULT_INDEX_LIMIT, DEFAULT_READ_LENGTH, MAX_CONTENT_CHARS, MAX_SUMMARY_CHARS, MAX_TAG_CHARS, MAX_TOPIC_CHARS, MAX_TAGS } from './context-cache.js'
import { bm25Scores } from './bm25.js'

const VERSION = '0.7.4'
const NS_SEP = '\x1f'
const MAX_IDENTIFIER_CHARS = 256
const MAX_TEXT_CHARS = 1_000_000
const MAX_ITEMS = 10_000
const MAX_TOP_K = 50
const SEARCH_CHUNK_CHARS = 700
const SEARCH_CHUNK_OVERLAP = 120

interface StoredText {
  value: string
  createdAt: string
  updatedAt: string
}

interface DocEntry extends StoredText {
  id: string
  language: string
  description: string
}

interface DiskData {
  memory: Record<string, StoredText>
  docs: Record<string, DocEntry>
}

interface SearchResult {
  id: string
  score: number
  text: string
  updatedAt: string
}

interface Backend {
  memorySet(key: string, value: string, namespace: string): Promise<unknown>
  memoryGet(key: string, namespace: string): Promise<unknown>
  memoryList(namespace: string): Promise<unknown>
  memoryDelete(key: string, namespace: string): Promise<unknown>
  memorySearch(query: string, topK: number): Promise<unknown>
  docSave(id: string, text: string, language: string, description: string): Promise<unknown>
  docGet(id: string): Promise<unknown>
  docSearch(query: string, topK: number): Promise<unknown>
  docList(): Promise<unknown>
  docDelete(id: string): Promise<unknown>
  cacheStore(id: string, content: string, topic: string, summary: string, tags: string[]): Promise<unknown>
  cacheRead(id: string, offset: number, length: number): Promise<unknown>
  cacheIndex(topic: string | null, limit: number): Promise<unknown>
  cacheSearch(query: string, topK: number): Promise<unknown>
  cacheList(): Promise<unknown>
  cacheDelete(id: string): Promise<unknown>
  cacheStats(): Promise<unknown>
  cacheGc(): Promise<unknown>
}

function defaultStorageDir(): string {
  const base = join(homedir(), '.whimsicality')
  const newPath = join(base, 'storage')
  const oldPath = join(base, 'kernel-storage')
  try {
    if (!existsSync(newPath) && existsSync(oldPath)) renameSync(oldPath, newPath)
  } catch { }
  return newPath
}

const emptyData = (): DiskData => ({ memory: {}, docs: {} })
const now = (): string => new Date().toISOString()

function stored(value: string, previous?: StoredText): StoredText {
  const timestamp = now()
  return { value, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp }
}

function normalizeStored(value: unknown): StoredText | null {
  if (typeof value === 'string') return { value, createdAt: '', updatedAt: '' }
  if (!value || typeof value !== 'object') return null
  const item = value as Partial<StoredText>
  if (typeof item.value !== 'string') return null
  return {
    value: item.value,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
  }
}

function normalizeMap(value: unknown): Record<string, StoredText> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    const normalized = normalizeStored(item)
    return normalized ? [[key, normalized]] : []
  }))
}

function normalizeData(value: unknown): DiskData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyData()
  const parsed = value as Record<string, unknown>
  const docs: Record<string, DocEntry> = {}
  if (parsed.docs && typeof parsed.docs === 'object' && !Array.isArray(parsed.docs)) {
    for (const [id, raw] of Object.entries(parsed.docs)) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      const base = normalizeStored(item) ?? normalizeStored(item.text) ?? normalizeStored(item.code)
      if (!base) continue
      docs[id] = {
        ...base,
        id: typeof item.id === 'string' ? item.id : id,
        language: typeof item.language === 'string' ? item.language : '',
        description: typeof item.description === 'string' ? item.description : '',
      }
    }
  }
  const memory = normalizeMap(parsed.memory)
  for (const legacy of ['context', 'facts', 'plans', 'snippets'] as const) {
    if (parsed[legacy] && typeof parsed[legacy] === 'object' && !Array.isArray(parsed[legacy])) {
      for (const [key, raw] of Object.entries(parsed[legacy] as Record<string, unknown>)) {
        const base = normalizeStored(raw) ?? normalizeStored((raw as Record<string, unknown>)?.code) ?? normalizeStored((raw as Record<string, unknown>)?.value)
        if (base) memory[`${legacy}${NS_SEP}${key}`] = base
      }
    }
  }
  return { memory, docs }
}

function chunks(text: string): { text: string; start: number }[] {
  if (text.length <= SEARCH_CHUNK_CHARS) return [{ text, start: 0 }]
  const result: { text: string; start: number }[] = []
  const step = SEARCH_CHUNK_CHARS - SEARCH_CHUNK_OVERLAP
  for (let start = 0; start < text.length; start += step) {
    result.push({ text: text.slice(start, start + SEARCH_CHUNK_CHARS), start })
    if (start + SEARCH_CHUNK_CHARS >= text.length) break
  }
  return result
}

function bestChunk(chunkList: { text: string; start: number }[], chunkScores: number[]): { score: number; text: string; start: number } {
  let best = { score: 0, text: '', start: 0 }
  for (let i = 0; i < chunkList.length; i++) {
    const score = chunkScores[i] ?? 0
    if (score > best.score) best = { score, text: chunkList[i].text, start: chunkList[i].start }
  }
  return best
}

class DiskStore {
  private readonly filePath: string
  private data = emptyData()

  constructor(storageDir: string) {
    mkdirSync(storageDir, { recursive: true })
    this.filePath = join(storageDir, 'whim-mcp-store.json')
    this.refresh()
  }

  private read(): DiskData {
    try {
      return normalizeData(JSON.parse(readFileSync(this.filePath, 'utf-8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyData()
      const corruptPath = `${this.filePath}.corrupt-${Date.now()}`
      try { renameSync(this.filePath, corruptPath) } catch { }
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`whimsicality-mcp: corrupt store renamed to ${corruptPath} (${message}); starting fresh\n`)
      return emptyData()
    }
  }

  private refresh(): DiskData {
    this.data = this.read()
    return this.data
  }

  private async mutate<T>(collection: keyof DiskData, change: (data: DiskData) => T): Promise<T> {
    const release = await lockfile.lock(this.filePath, {
      realpath: false,
      stale: 10_000,
      retries: { retries: 8, factor: 1.5, minTimeout: 10, maxTimeout: 250, randomize: true },
    })
    try {
      const data = this.read()
      const beforeCount = Object.keys(data[collection]).length
      const clone: DiskData = { memory: { ...data.memory }, docs: { ...data.docs } }
      const result = change(clone)
      if (beforeCount < Object.keys(clone[collection]).length && beforeCount >= MAX_ITEMS) throw new Error(`${collection} item limit (${MAX_ITEMS}) reached`)
      const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(temporary, JSON.stringify(clone), 'utf-8')
      try {
        const fd = openSync(temporary, 'r+')
        try { fsyncSync(fd) } catch { }
        closeSync(fd)
      } catch { }
      try { renameSync(temporary, this.filePath) } catch (error) { try { unlinkSync(temporary) } catch { }; throw error }
      try {
        const dirFd = openSync(dirname(this.filePath), 'r')
        try { fsyncSync(dirFd) } catch { }
        closeSync(dirFd)
      } catch { }
      this.data = clone
      return result
    } finally {
      await release()
    }
  }

  async memorySet(namespace: string, key: string, value: string): Promise<void> {
    await this.mutate('memory', (data) => { const id = `${namespace}${NS_SEP}${key}`; data.memory[id] = stored(value, data.memory[id]) })
  }
  memoryGet(namespace: string, key: string): StoredText | null { return this.refresh().memory[`${namespace}${NS_SEP}${key}`] ?? null }
  memoryList(namespace: string): string[] { const prefix = `${namespace}${NS_SEP}`; return Object.keys(this.refresh().memory).filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)).sort() }
  async memoryDelete(namespace: string, key: string): Promise<boolean> {
    const id = `${namespace}${NS_SEP}${key}`
    return this.mutate('memory', (data) => {
      const existed = id in data.memory
      delete data.memory[id]
      return existed
    })
  }
  memorySearch(query: string, topK: number): (StoredText & { key: string; namespace: string; score: number })[] {
    const entries = Object.entries(this.refresh().memory)
    if (entries.length === 0) return []
    const scores = bm25Scores(query, entries.map(([, item]) => item.value))
    return entries
      .map(([id, item], i) => {
        const sep = id.indexOf(NS_SEP)
        const namespace = sep >= 0 ? id.slice(0, sep) : 'default'
        const key = sep >= 0 ? id.slice(sep + NS_SEP.length) : id
        return { ...item, key, namespace, score: scores[i] }
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, topK)
  }

  async docSave(id: string, text: string, language: string, description: string): Promise<void> {
    await this.mutate('docs', (data) => { data.docs[id] = { id, language, description, ...stored(text, data.docs[id]) } })
  }
  docGet(id: string): DocEntry | null { return this.refresh().docs[id] ?? null }
  docList(): string[] { return Object.keys(this.refresh().docs).sort() }
  async docDelete(id: string): Promise<boolean> {
    return this.mutate('docs', (data) => {
      const existed = id in data.docs
      delete data.docs[id]
      return existed
    })
  }
  docSearch(query: string, topK: number): SearchResult[] {
    const docs = Object.values(this.refresh().docs)
    if (docs.length === 0) return []
    const docChunks = docs.map((doc) => ({ doc, chunkList: chunks(doc.value) }))
    const allChunkTexts = docChunks.flatMap(({ chunkList }) => chunkList.map((c) => c.text))
    const scores = bm25Scores(query, allChunkTexts)
    let offset = 0
    return docChunks
      .map(({ doc, chunkList }) => {
        const chunkScores = scores.slice(offset, offset + chunkList.length)
        offset += chunkList.length
        return { doc, match: bestChunk(chunkList, chunkScores) }
      })
      .filter(({ match }) => match.score > 0)
      .sort((a, b) => b.match.score - a.match.score || b.doc.updatedAt.localeCompare(a.doc.updatedAt))
      .slice(0, topK)
      .map(({ doc, match }) => ({ id: doc.id, score: match.score, text: match.text, updatedAt: doc.updatedAt }))
  }
}

class DiskBackend implements Backend {
  protected readonly store: DiskStore
  protected readonly cache: ContextCache
  constructor(storageDir: string) {
    this.store = new DiskStore(storageDir)
    this.cache = new ContextCache(storageDir)
  }
  async memorySet(key: string, value: string, namespace: string): Promise<unknown> { await this.store.memorySet(namespace, key, value); return { stored: true } }
  async memoryGet(key: string, namespace: string): Promise<unknown> { const item = this.store.memoryGet(namespace, key); if (!item) throw new Error(`not found: ${namespace}/${key}`); return { key, namespace, text: item.value, createdAt: item.createdAt, updatedAt: item.updatedAt } }
  async memoryList(namespace: string): Promise<unknown> { return { keys: this.store.memoryList(namespace) } }
  async memoryDelete(key: string, namespace: string): Promise<unknown> { const existed = await this.store.memoryDelete(namespace, key); return { deleted: existed } }
  async memorySearch(query: string, topK: number): Promise<unknown> { return { results: this.store.memorySearch(query, topK) } }
  async docSave(id: string, text: string, language: string, description: string): Promise<unknown> { await this.store.docSave(id, text, language, description); return { saved: true } }
  async docGet(id: string): Promise<unknown> { const doc = this.store.docGet(id); if (!doc) throw new Error(`not found: ${id}`); return { id, text: doc.value, language: doc.language, description: doc.description, createdAt: doc.createdAt, updatedAt: doc.updatedAt } }
  async docSearch(query: string, topK: number): Promise<unknown> { return { results: this.store.docSearch(query, topK) } }
  async docList(): Promise<unknown> { return { ids: this.store.docList() } }
  async docDelete(id: string): Promise<unknown> { const existed = await this.store.docDelete(id); return { deleted: existed } }
  async cacheStore(id: string, content: string, topic: string, summary: string, tags: string[]): Promise<unknown> { return this.cache.store(id, content, topic, summary, tags) }
  async cacheRead(id: string, offset: number, length: number): Promise<unknown> { const result = this.cache.read(id, offset, length); if (!result) throw new Error(`not found: ${id}`); return { id, content: result.content, topic: result.entry.topic, summary: result.entry.summary, tags: result.entry.tags, offset: result.offset, length: result.length, totalLength: result.totalLength, hasMore: result.hasMore, createdAt: result.entry.createdAt, updatedAt: result.entry.updatedAt } }
  async cacheIndex(topic: string | null, limit: number): Promise<unknown> { return { table: this.cache.indexTable(topic, limit) } }
  async cacheSearch(query: string, topK: number): Promise<unknown> { return { results: this.cache.search(query, topK) } }
  async cacheList(): Promise<unknown> { return { ids: this.cache.list() } }
  async cacheDelete(id: string): Promise<unknown> { return { deleted: await this.cache.delete(id) } }
  async cacheStats(): Promise<unknown> { return this.cache.stats() }
  async cacheGc(): Promise<unknown> { return this.cache.gc() }
}

interface ToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false }
  annotations?: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
}

const stringProperty = (description: string, maxLength = MAX_TEXT_CHARS): Record<string, unknown> => ({ type: 'string', minLength: 1, maxLength, description })
const optionalStringProperty = (description: string, maxLength: number): Record<string, unknown> => ({ type: 'string', maxLength, description })
const schema = (properties: Record<string, unknown>, required: string[] = []): ToolDef['inputSchema'] => ({ type: 'object', properties, required, additionalProperties: false })
const keyProperty = stringProperty('Key or identifier within the namespace', MAX_IDENTIFIER_CHARS)
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
const idProperty = stringProperty('Document identifier', MAX_IDENTIFIER_CHARS)
const namespaceProperty = stringProperty('Namespace to isolate keys (default: "default")', MAX_IDENTIFIER_CHARS)
const languageProperty = stringProperty('Programming language or format tag (e.g. typescript, python, rust, markdown)', MAX_IDENTIFIER_CHARS)
const topKProperty = { type: 'integer', minimum: 1, maximum: MAX_TOP_K, description: 'Number of results (default: 5)' }

const TOOLS: readonly ToolDef[] = [
  { name: 'whim_memory_set', description: 'Store persistent text in a namespaced key-value memory. Use for facts, plans, context, decisions, or any text an agent should recall later.', inputSchema: schema({ key: keyProperty, value: stringProperty('Text to store'), namespace: namespaceProperty }, ['key', 'value']), annotations: WRITE },
  { name: 'whim_memory_get', description: 'Retrieve a stored memory value by key and namespace. Returns error if not found.', inputSchema: schema({ key: keyProperty, namespace: namespaceProperty }, ['key']), annotations: RO },
  { name: 'whim_memory_list', description: 'List all keys in a namespace.', inputSchema: schema({ namespace: namespaceProperty }), annotations: RO },
  { name: 'whim_memory_delete', description: 'Delete a memory entry. The key argument is required to prevent accidental data loss. Returns deleted:false if the key did not exist.', inputSchema: schema({ key: keyProperty, namespace: namespaceProperty }, ['key']), annotations: DELETE },
  { name: 'whim_memory_search', description: 'BM25 lexical search across all memory values. Returns ranked matches with scores.', inputSchema: schema({ query: stringProperty('Search query', 10_000), topK: topKProperty }, ['query']), annotations: RO },
  { name: 'whim_doc_save', description: 'Save a document for BM25 lexical chunk search. Use for long-form text, code, or reference material.', inputSchema: schema({ id: idProperty, text: stringProperty('Document text'), language: languageProperty, description: stringProperty('Optional short description', 10_000) }, ['id', 'text']), annotations: WRITE },
  { name: 'whim_doc_get', description: 'Retrieve a full document by ID. Returns error if not found.', inputSchema: schema({ id: idProperty }, ['id']), annotations: RO },
  { name: 'whim_doc_search', description: 'BM25 lexical search over saved documents. Returns match-centered chunks.', inputSchema: schema({ query: stringProperty('Search query', 10_000), topK: topKProperty }, ['query']), annotations: RO },
  { name: 'whim_doc_list', description: 'List saved document IDs.', inputSchema: schema({}), annotations: RO },
  { name: 'whim_doc_delete', description: 'Delete a document. The id argument is required. Returns deleted:false if the id did not exist.', inputSchema: schema({ id: idProperty }, ['id']), annotations: DELETE },
  { name: 'whim_cache_store', description: 'Store large content in the paged context cache. Content is brotli-compressed on disk to save space. Returns chunk ID with compression stats. Use for content too large for direct context injection — read it back in pages via whim_cache_read.', inputSchema: schema({ id: idProperty, content: stringProperty('Content to cache (will be compressed)', MAX_CONTENT_CHARS), topic: optionalStringProperty('Short topic label (auto-generated from first heading if omitted or empty)', MAX_TOPIC_CHARS), summary: optionalStringProperty('One-line summary for the index table (auto-generated if omitted or empty)', MAX_SUMMARY_CHARS), tags: { type: 'array', items: { type: 'string', maxLength: MAX_TAG_CHARS }, maxItems: MAX_TAGS, description: 'Optional tags for filtering and search' } }, ['id', 'content']), annotations: WRITE },
  { name: 'whim_cache_index', description: 'Get a compact summary table of all cached content. Designed to be injected into context. Token cost is printed at the bottom of the table (roughly 1 token per 4 characters of rendered text, so ~35 tokens per entry with typical topic/summary lengths). Use this to discover what is available before calling whim_cache_read.', inputSchema: schema({ topic: stringProperty('Optional topic filter', MAX_TOPIC_CHARS), limit: { type: 'integer', minimum: 1, maximum: 500, description: `Max entries to show (default: ${DEFAULT_INDEX_LIMIT})` } }), annotations: RO },
  { name: 'whim_cache_read', description: 'Read and decompress a cached chunk by ID. Supports paging via offset and length — only load the portion you need. Returns content, offset, length, totalLength, and hasMore. Recently read chunks are kept in an LRU cache for fast repeat access.', inputSchema: schema({ id: idProperty, offset: { type: 'integer', minimum: 0, description: 'Character offset to start reading from (default: 0)' }, length: { type: 'integer', minimum: 1, maximum: MAX_CONTENT_CHARS, description: 'Maximum characters to return (default: 8000)' } }, ['id']), annotations: RO },
  { name: 'whim_cache_search', description: 'BM25 search over cache index entries (topic, summary, tags). Returns ranked summaries — use to find relevant chunk IDs before reading full content.', inputSchema: schema({ query: stringProperty('Search query', 10_000), topK: topKProperty }, ['query']), annotations: RO },
  { name: 'whim_cache_list', description: 'List all cached chunk IDs.', inputSchema: schema({}), annotations: RO },
  { name: 'whim_cache_delete', description: 'Delete a cached chunk. The id argument is required. Returns deleted:false if the id did not exist.', inputSchema: schema({ id: idProperty }, ['id']), annotations: DELETE },
  { name: 'whim_cache_stats', description: 'Return cache statistics: entry count, total original bytes, total compressed bytes, compression ratio.', inputSchema: schema({}), annotations: RO },
  { name: 'whim_cache_gc', description: 'Remove orphaned chunk files that have no index entry. Returns count of files removed and bytes freed.', inputSchema: schema({}), annotations: DELETE },
]

function requireString(args: Record<string, unknown>, name: string, maxLength = MAX_TEXT_CHARS): string {
  const value = args[name]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing or invalid required argument: "${name}" (expected non-empty string)`)
  if (value.length > maxLength) throw new Error(`Argument "${name}" exceeds maximum length of ${maxLength}`)
  return value
}

function optionalIdentifier(args: Record<string, unknown>, name: string, fallback: string): string {
  const value = args[name]
  return validateIdentifier(value === undefined ? fallback : requireString(args, name, MAX_IDENTIFIER_CHARS), name)
}

function validateIdentifier(value: string, name: string): string {
  if (value.length > MAX_IDENTIFIER_CHARS) throw new Error(`Argument "${name}" exceeds maximum length of ${MAX_IDENTIFIER_CHARS}`)
  if (value.includes(NS_SEP) || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error(`Argument "${name}" must not contain control characters`)
  return value
}

function topK(args: Record<string, unknown>): number {
  const value = args.topK ?? 5
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_TOP_K) throw new Error(`Argument "topK" must be an integer from 1 to ${MAX_TOP_K}`)
  return value as number
}

async function dispatch(backend: Backend, name: string, args: Record<string, unknown>): Promise<unknown> {
  const id = (argument: string, fallback?: string): string => fallback === undefined ? validateIdentifier(requireString(args, argument, MAX_IDENTIFIER_CHARS), argument) : optionalIdentifier(args, argument, fallback)
  const namespace = (): string => optionalIdentifier(args, 'namespace', 'default')
  switch (name) {
    case 'whim_memory_set': return backend.memorySet(id('key'), requireString(args, 'value'), namespace())
    case 'whim_memory_get': return backend.memoryGet(id('key'), namespace())
    case 'whim_memory_list': return backend.memoryList(namespace())
    case 'whim_memory_delete': return backend.memoryDelete(id('key'), namespace())
    case 'whim_memory_search': return backend.memorySearch(requireString(args, 'query', 10_000), topK(args))
    case 'whim_doc_save': return backend.docSave(id('id'), requireString(args, 'text'), args.language === undefined ? '' : requireString(args, 'language', MAX_IDENTIFIER_CHARS), args.description === undefined ? '' : requireString(args, 'description', 10_000))
    case 'whim_doc_get': return backend.docGet(id('id'))
    case 'whim_doc_search': return backend.docSearch(requireString(args, 'query', 10_000), topK(args))
    case 'whim_doc_list': return backend.docList()
    case 'whim_doc_delete': return backend.docDelete(id('id'))
    case 'whim_cache_store': {
      const tagsRaw = args.tags
      const tags: string[] = []
      if (Array.isArray(tagsRaw)) {
        for (const t of tagsRaw) {
          if (typeof t !== 'string' || t.length === 0) throw new Error('tags must be non-empty strings')
          if (t.length > MAX_TAG_CHARS) throw new Error(`tag exceeds maximum length of ${MAX_TAG_CHARS}`)
          tags.push(t)
        }
        if (tags.length > MAX_TAGS) throw new Error(`too many tags (max ${MAX_TAGS})`)
      }
      const topic = typeof args.topic === 'string' && args.topic.length > 0 ? requireString(args, 'topic', MAX_TOPIC_CHARS) : ''
      const summary = typeof args.summary === 'string' && args.summary.length > 0 ? requireString(args, 'summary', MAX_SUMMARY_CHARS) : ''
      return backend.cacheStore(id('id'), requireString(args, 'content', MAX_CONTENT_CHARS), topic, summary, tags)
    }
    case 'whim_cache_read': {
      const offset = args.offset === undefined ? 0 : (() => {
        const v = args.offset
        if (!Number.isInteger(v) || (v as number) < 0) throw new Error('Argument "offset" must be a non-negative integer')
        return v as number
      })()
      const length = args.length === undefined ? DEFAULT_READ_LENGTH : (() => {
        const v = args.length
        if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > MAX_CONTENT_CHARS) throw new Error(`Argument "length" must be an integer from 1 to ${MAX_CONTENT_CHARS}`)
        return v as number
      })()
      return backend.cacheRead(id('id'), offset, length)
    }
    case 'whim_cache_index': {
      const topic = args.topic === undefined ? null : requireString(args, 'topic', MAX_TOPIC_CHARS)
      const limit = args.limit === undefined ? DEFAULT_INDEX_LIMIT : (() => {
        const v = args.limit
        if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 500) throw new Error('Argument "limit" must be an integer from 1 to 500')
        return v as number
      })()
      return backend.cacheIndex(topic, limit)
    }
    case 'whim_cache_search': return backend.cacheSearch(requireString(args, 'query', 10_000), topK(args))
    case 'whim_cache_list': return backend.cacheList()
    case 'whim_cache_delete': return backend.cacheDelete(id('id'))
    case 'whim_cache_stats': return backend.cacheStats()
    case 'whim_cache_gc': return backend.cacheGc()
    default: throw new Error(`Unknown tool: ${name}`)
  }
}

async function main(): Promise<void> {
  const storageDir = process.env.WHIMSICALITY_STORAGE_DIR ?? defaultStorageDir()
  const backend = new DiskBackend(storageDir)
  const server = new Server({ name: 'whimsicality-mcp', version: VERSION }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await dispatch(backend, request.params.name, (request.params.arguments ?? {}) as Record<string, unknown>)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    } catch (error) {
      return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true }
    }
  })
  await server.connect(new StdioServerTransport())
}

main().catch((error) => {
  process.stderr.write(`whimsicality-mcp: fatal: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
