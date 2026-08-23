#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'

const VERSION = '0.5.0'
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
}

function defaultStorageDir(): string {
  return join(homedir(), '.whimsicality', 'kernel-storage')
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

const EDGE_PUNCT = /^[.\-+#]+|[.\-+#]+$/g
const MEANINGFUL_INTERNAL_PUNCT = /[#+]/

function tokenize(text: string): string[] {
  const raw = text.toLocaleLowerCase().match(/[\p{L}\p{N}_+#.-]+/gu) ?? []
  const result: string[] = []
  for (const token of raw) {
    const stripped = token.replace(EDGE_PUNCT, '')
    if (stripped) {
      result.push(stripped)
      if (stripped !== token && MEANINGFUL_INTERNAL_PUNCT.test(token)) result.push(token)
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
  constructor(storageDir: string) { this.store = new DiskStore(storageDir) }
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
}

interface ToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false }
}

const stringProperty = (description: string, maxLength = MAX_TEXT_CHARS): Record<string, unknown> => ({ type: 'string', minLength: 1, maxLength, description })
const schema = (properties: Record<string, unknown>, required: string[] = []): ToolDef['inputSchema'] => ({ type: 'object', properties, required, additionalProperties: false })
const keyProperty = stringProperty('Key or identifier within the namespace', MAX_IDENTIFIER_CHARS)
const idProperty = stringProperty('Document identifier', MAX_IDENTIFIER_CHARS)
const namespaceProperty = stringProperty('Namespace to isolate keys (default: "default")', MAX_IDENTIFIER_CHARS)
const languageProperty = stringProperty('Programming language or format tag (e.g. typescript, python, rust, markdown)', MAX_IDENTIFIER_CHARS)
const topKProperty = { type: 'integer', minimum: 1, maximum: MAX_TOP_K, description: 'Number of results (default: 5)' }

const TOOLS: readonly ToolDef[] = [
  { name: 'whim_memory_set', description: 'Store persistent text in a namespaced key-value memory. Use for facts, plans, context, decisions, or any text an agent should recall later.', inputSchema: schema({ key: keyProperty, value: stringProperty('Text to store'), namespace: namespaceProperty }, ['key', 'value']) },
  { name: 'whim_memory_get', description: 'Retrieve a stored memory value by key and namespace. Returns error if not found.', inputSchema: schema({ key: keyProperty, namespace: namespaceProperty }, ['key']) },
  { name: 'whim_memory_list', description: 'List all keys in a namespace.', inputSchema: schema({ namespace: namespaceProperty }) },
  { name: 'whim_memory_delete', description: 'Delete a memory entry. The key argument is required to prevent accidental data loss. Returns deleted:false if the key did not exist.', inputSchema: schema({ key: keyProperty, namespace: namespaceProperty }, ['key']) },
  { name: 'whim_memory_search', description: 'BM25 lexical search across all memory values. Returns ranked matches with scores.', inputSchema: schema({ query: stringProperty('Search query', 10_000), topK: topKProperty }, ['query']) },
  { name: 'whim_doc_save', description: 'Save a document for BM25 lexical chunk search. Use for long-form text, code, or reference material.', inputSchema: schema({ id: idProperty, text: stringProperty('Document text'), language: languageProperty, description: stringProperty('Optional short description', 10_000) }, ['id', 'text']) },
  { name: 'whim_doc_get', description: 'Retrieve a full document by ID. Returns error if not found.', inputSchema: schema({ id: idProperty }, ['id']) },
  { name: 'whim_doc_search', description: 'BM25 lexical search over saved documents. Returns match-centered chunks.', inputSchema: schema({ query: stringProperty('Search query', 10_000), topK: topKProperty }, ['query']) },
  { name: 'whim_doc_list', description: 'List saved document IDs.', inputSchema: schema({}) },
  { name: 'whim_doc_delete', description: 'Delete a document. The id argument is required. Returns deleted:false if the id did not exist.', inputSchema: schema({ id: idProperty }, ['id']) },
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
