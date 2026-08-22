#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { KernelClient, defaultStorageDir } from './kernel-client.js'

const VERSION = '0.3.0'
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

interface Snippet extends StoredText {
  name: string
  language: string
  description: string
}

interface IndexedDoc extends StoredText {
  id: string
}

interface DiskData {
  context: Record<string, StoredText>
  facts: Record<string, StoredText>
  plans: Record<string, StoredText>
  snippets: Record<string, Snippet>
  docs: Record<string, IndexedDoc>
}

interface SearchResult {
  id: string
  score: number
  text: string
  updatedAt: string
}

interface Backend {
  contextSet(key: string, text: string, namespace: string): Promise<unknown>
  contextGet(key: string, namespace: string): Promise<unknown>
  contextList(namespace: string): Promise<unknown>
  contextDelete(key: string, namespace: string): Promise<unknown>
  factsSave(name: string, value: string): Promise<unknown>
  factsGet(name: string): Promise<unknown>
  factsList(): Promise<unknown>
  factsDelete(name: string): Promise<unknown>
  planSave(name: string, plan: string): Promise<unknown>
  planGet(name: string): Promise<unknown>
  planList(): Promise<unknown>
  planDelete(name: string): Promise<unknown>
  ragIndex(id: string, text: string): Promise<unknown>
  ragSearch(query: string, topK: number): Promise<unknown>
  ragList(): Promise<unknown>
  ragDelete(id: string): Promise<unknown>
  snippetSave(name: string, language: string, code: string, description: string): Promise<unknown>
  snippetSearch(query: string, topK: number): Promise<unknown>
  snippetList(): Promise<unknown>
  snippetDelete(name: string): Promise<unknown>
}

const emptyData = (): DiskData => ({ context: {}, facts: {}, plans: {}, snippets: {}, docs: {} })
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
  const snippets: Record<string, Snippet> = {}
  if (parsed.snippets && typeof parsed.snippets === 'object' && !Array.isArray(parsed.snippets)) {
    for (const [name, raw] of Object.entries(parsed.snippets)) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      const base = normalizeStored(item) ?? normalizeStored(item.code)
      if (!base) continue
      snippets[name] = {
        ...base,
        name: typeof item.name === 'string' ? item.name : name,
        language: typeof item.language === 'string' ? item.language : '',
        description: typeof item.description === 'string' ? item.description : '',
      }
    }
  }
  const docs: Record<string, IndexedDoc> = {}
  if (parsed.docs && typeof parsed.docs === 'object' && !Array.isArray(parsed.docs)) {
    for (const [id, raw] of Object.entries(parsed.docs)) {
      if (!raw || typeof raw !== 'object') continue
      const item = raw as Record<string, unknown>
      const base = normalizeStored(item) ?? normalizeStored(item.text)
      if (!base) continue
      docs[id] = { ...base, id: typeof item.id === 'string' ? item.id : id }
    }
  }
  return {
    context: normalizeMap(parsed.context),
    facts: normalizeMap(parsed.facts),
    plans: normalizeMap(parsed.plans),
    snippets,
    docs,
  }
}

function tokenize(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}_+#.-]+/gu) ?? []
}

function textSimilarity(query: string, text: string): number {
  const queryTerms = [...new Set(tokenize(query))]
  if (queryTerms.length === 0) return 0
  const terms = new Set(tokenize(text))
  return queryTerms.filter((term) => terms.has(term)).length / queryTerms.length
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

function bestChunk(query: string, text: string): { score: number; text: string; start: number } {
  return chunks(text)
    .map((chunk) => ({ ...chunk, score: textSimilarity(query, chunk.text) }))
    .sort((a, b) => b.score - a.score || a.start - b.start)[0] ?? { score: 0, text: '', start: 0 }
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
      const result = change(data)
      if (beforeCount < Object.keys(data[collection]).length && beforeCount >= MAX_ITEMS) throw new Error(`${collection} item limit (${MAX_ITEMS}) reached`)
      const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(temporary, JSON.stringify(data), 'utf-8')
      try { renameSync(temporary, this.filePath) } catch (error) { try { unlinkSync(temporary) } catch { }; throw error }
      this.data = data
      return result
    } finally {
      await release()
    }
  }

  async contextSet(namespace: string, key: string, text: string): Promise<void> {
    await this.mutate('context', (data) => { const id = `${namespace}${NS_SEP}${key}`; data.context[id] = stored(text, data.context[id]) })
  }
  contextGet(namespace: string, key: string): StoredText | null { return this.refresh().context[`${namespace}${NS_SEP}${key}`] ?? null }
  contextList(namespace: string): string[] { const prefix = `${namespace}${NS_SEP}`; return Object.keys(this.refresh().context).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)).sort() }
  async contextDelete(namespace: string, key: string): Promise<boolean> { return this.mutate('context', (data) => delete data.context[`${namespace}${NS_SEP}${key}`]) }

  async factsSave(name: string, value: string): Promise<void> { await this.mutate('facts', (data) => { data.facts[name] = stored(value, data.facts[name]) }) }
  factsGet(name: string): StoredText | null { return this.refresh().facts[name] ?? null }
  factsList(): string[] { return Object.keys(this.refresh().facts).sort() }
  async factsDelete(name: string): Promise<boolean> { return this.mutate('facts', (data) => delete data.facts[name]) }

  async planSave(name: string, value: string): Promise<void> { await this.mutate('plans', (data) => { data.plans[name] = stored(value, data.plans[name]) }) }
  planGet(name: string): StoredText | null { return this.refresh().plans[name] ?? null }
  planList(): string[] { return Object.keys(this.refresh().plans).sort() }
  async planDelete(name: string): Promise<boolean> { return this.mutate('plans', (data) => delete data.plans[name]) }

  async ragIndex(id: string, text: string): Promise<void> { await this.mutate('docs', (data) => { data.docs[id] = { id, ...stored(text, data.docs[id]) } }) }
  ragList(): string[] { return Object.keys(this.refresh().docs).sort() }
  async ragDelete(id: string): Promise<boolean> { return this.mutate('docs', (data) => delete data.docs[id]) }
  ragSearch(query: string, topK: number): SearchResult[] {
    return Object.values(this.refresh().docs)
      .map((doc) => ({ doc, match: bestChunk(query, doc.value) }))
      .filter(({ match }) => match.score > 0)
      .sort((a, b) => b.match.score - a.match.score || b.doc.updatedAt.localeCompare(a.doc.updatedAt))
      .slice(0, topK)
      .map(({ doc, match }) => ({ id: doc.id, score: match.score, text: match.text, updatedAt: doc.updatedAt }))
  }

  async snippetSave(name: string, language: string, code: string, description: string): Promise<void> {
    await this.mutate('snippets', (data) => { data.snippets[name] = { name, language, description, ...stored(code, data.snippets[name]) } })
  }
  snippetList(): string[] { return Object.keys(this.refresh().snippets).sort() }
  async snippetDelete(name: string): Promise<boolean> { return this.mutate('snippets', (data) => delete data.snippets[name]) }
  snippetSearch(query: string, topK: number): (Snippet & { code: string; score: number })[] {
    return Object.values(this.refresh().snippets)
      .map((snippet) => ({ ...snippet, code: snippet.value, score: textSimilarity(query, `${snippet.name} ${snippet.language} ${snippet.description} ${snippet.value}`) }))
      .filter((snippet) => snippet.score > 0)
      .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, topK)
  }
}

class DiskBackend implements Backend {
  protected readonly store: DiskStore
  constructor(storageDir: string) { this.store = new DiskStore(storageDir) }
  async contextSet(key: string, text: string, namespace: string): Promise<unknown> { await this.store.contextSet(namespace, key, text); return { stored: true } }
  async contextGet(key: string, namespace: string): Promise<unknown> { const item = this.store.contextGet(namespace, key); return item ? { text: item.value, createdAt: item.createdAt, updatedAt: item.updatedAt } : { text: null, error: 'not found' } }
  async contextList(namespace: string): Promise<unknown> { return { keys: this.store.contextList(namespace) } }
  async contextDelete(key: string, namespace: string): Promise<unknown> { return { deleted: await this.store.contextDelete(namespace, key) } }
  async factsSave(name: string, value: string): Promise<unknown> { await this.store.factsSave(name, value); return { saved: true } }
  async factsGet(name: string): Promise<unknown> { const item = this.store.factsGet(name); return item ? { name, value: item.value, createdAt: item.createdAt, updatedAt: item.updatedAt } : { name, value: null, error: 'not found' } }
  async factsList(): Promise<unknown> { return { names: this.store.factsList() } }
  async factsDelete(name: string): Promise<unknown> { return { deleted: await this.store.factsDelete(name) } }
  async planSave(name: string, plan: string): Promise<unknown> { await this.store.planSave(name, plan); return { saved: true } }
  async planGet(name: string): Promise<unknown> { const item = this.store.planGet(name); return item ? { name, plan: item.value, createdAt: item.createdAt, updatedAt: item.updatedAt } : { name, plan: null, error: 'not found' } }
  async planList(): Promise<unknown> { return { names: this.store.planList() } }
  async planDelete(name: string): Promise<unknown> { return { deleted: await this.store.planDelete(name) } }
  async ragIndex(id: string, text: string): Promise<unknown> { await this.store.ragIndex(id, text); return { indexed: true } }
  async ragSearch(query: string, topK: number): Promise<unknown> { return { results: this.store.ragSearch(query, topK) } }
  async ragList(): Promise<unknown> { return { ids: this.store.ragList() } }
  async ragDelete(id: string): Promise<unknown> { return { deleted: await this.store.ragDelete(id) } }
  async snippetSave(name: string, language: string, code: string, description: string): Promise<unknown> { await this.store.snippetSave(name, language, code, description); return { saved: true } }
  async snippetSearch(query: string, topK: number): Promise<unknown> { return { results: this.store.snippetSearch(query, topK) } }
  async snippetList(): Promise<unknown> { return { names: this.store.snippetList() } }
  async snippetDelete(name: string): Promise<unknown> { return { deleted: await this.store.snippetDelete(name) } }
}

class KernelBackend extends DiskBackend {
  private kernel: KernelClient | null = null
  constructor(private readonly storageDir: string, private readonly hotBudgetMb: number) { super(storageDir) }
  async start(): Promise<void> { this.kernel = new KernelClient({ storageDir: this.storageDir, hotBudgetMb: this.hotBudgetMb, autoRestart: true }); await this.kernel.start() }
  private async kernelCall(method: string, params: Record<string, unknown>): Promise<unknown> { if (!this.kernel) throw new Error('kernel not started'); return this.kernel.call(method, params) }
  private async mirror(method: string, params: Record<string, unknown>): Promise<void> { try { await this.kernelCall(method, params) } catch (error) { process.stderr.write(`whimsicality-mcp: kernel write failed; disk remains authoritative (${error instanceof Error ? error.message : String(error)})\n`) } }
  private kernelId(namespace: string, key: string): string { return `${namespace.length}:${namespace}${key}` }
  override async contextSet(key: string, text: string, namespace: string): Promise<unknown> { const result = await super.contextSet(key, text, namespace); await this.mirror('kernel.set_text', { id: this.kernelId(namespace, key), text, kind: 'reasoning' }); return result }
  override async contextGet(key: string, namespace: string): Promise<unknown> { try { const result = await this.kernelCall('kernel.get_text', { id: this.kernelId(namespace, key) }) as { text?: string | null }; if (result.text != null) return { text: result.text, source: 'kernel' } } catch { }; return super.contextGet(key, namespace) }
  override async contextDelete(key: string, namespace: string): Promise<unknown> { const result = await super.contextDelete(key, namespace); await this.mirror('kernel.delete', { id: this.kernelId(namespace, key) }); return result }
  override async factsSave(name: string, value: string): Promise<unknown> { const result = await super.factsSave(name, value); await this.mirror('kernel.set_text', { id: this.kernelId('facts', name), text: value, kind: 'reasoning' }); return result }
  override async factsDelete(name: string): Promise<unknown> { const result = await super.factsDelete(name); await this.mirror('kernel.delete', { id: this.kernelId('facts', name) }); return result }
  override async planSave(name: string, plan: string): Promise<unknown> { const result = await super.planSave(name, plan); await this.mirror('kernel.set_text', { id: this.kernelId('plans', name), text: plan, kind: 'summary' }); return result }
  override async planDelete(name: string): Promise<unknown> { const result = await super.planDelete(name); await this.mirror('kernel.delete', { id: this.kernelId('plans', name) }); return result }
}

interface ToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false }
}

const stringProperty = (description: string, maxLength = MAX_TEXT_CHARS): Record<string, unknown> => ({ type: 'string', minLength: 1, maxLength, description })
const schema = (properties: Record<string, unknown>, required: string[] = []): ToolDef['inputSchema'] => ({ type: 'object', properties, required, additionalProperties: false })
const nameProperty = stringProperty('Name or identifier', MAX_IDENTIFIER_CHARS)
const namespaceProperty = stringProperty('Optional namespace (default: default)', MAX_IDENTIFIER_CHARS)
const topKProperty = { type: 'integer', minimum: 1, maximum: MAX_TOP_K, description: 'Number of results (default: 5)' }

const TOOLS: readonly ToolDef[] = [
  { name: 'whim_context_set', description: 'Store persistent text in a namespaced slot.', inputSchema: schema({ key: nameProperty, text: stringProperty('Text to store'), namespace: namespaceProperty }, ['key', 'text']) },
  { name: 'whim_context_get', description: 'Retrieve a persistent text slot.', inputSchema: schema({ key: nameProperty, namespace: namespaceProperty }, ['key']) },
  { name: 'whim_context_list', description: 'List text slots in a namespace.', inputSchema: schema({ namespace: namespaceProperty }) },
  { name: 'whim_context_delete', description: 'Delete a text slot.', inputSchema: schema({ key: nameProperty, namespace: namespaceProperty }, ['key']) },
  { name: 'whim_facts_save', description: 'Save a named fact.', inputSchema: schema({ name: nameProperty, value: stringProperty('Fact value') }, ['name', 'value']) },
  { name: 'whim_facts_get', description: 'Retrieve a named fact.', inputSchema: schema({ name: nameProperty }, ['name']) },
  { name: 'whim_facts_list', description: 'List fact names.', inputSchema: schema({}) },
  { name: 'whim_facts_delete', description: 'Delete a named fact.', inputSchema: schema({ name: nameProperty }, ['name']) },
  { name: 'whim_plan_save', description: 'Save a named plan.', inputSchema: schema({ name: nameProperty, plan: stringProperty('Plan text') }, ['plan']) },
  { name: 'whim_plan_get', description: 'Retrieve a named plan.', inputSchema: schema({ name: nameProperty }) },
  { name: 'whim_plan_list', description: 'List plan names.', inputSchema: schema({}) },
  { name: 'whim_plan_delete', description: 'Delete a named plan.', inputSchema: schema({ name: nameProperty }) },
  { name: 'whim_rag_index', description: 'Index a document for lexical chunk search.', inputSchema: schema({ id: nameProperty, text: stringProperty('Document text') }, ['id', 'text']) },
  { name: 'whim_rag_search', description: 'Search indexed documents and return match-centered chunks.', inputSchema: schema({ query: stringProperty('Search query', 10_000), topK: topKProperty }, ['query']) },
  { name: 'whim_rag_list', description: 'List indexed document IDs.', inputSchema: schema({}) },
  { name: 'whim_rag_delete', description: 'Delete an indexed document.', inputSchema: schema({ id: nameProperty }, ['id']) },
  { name: 'whim_snippet_save', description: 'Save a reusable code snippet.', inputSchema: schema({ name: nameProperty, language: nameProperty, code: stringProperty('Snippet code'), description: stringProperty('Optional description', 10_000) }, ['name', 'language', 'code']) },
  { name: 'whim_snippet_search', description: 'Search saved snippets by lexical overlap.', inputSchema: schema({ query: stringProperty('Search query', 10_000), topK: topKProperty }, ['query']) },
  { name: 'whim_snippet_list', description: 'List snippet names.', inputSchema: schema({}) },
  { name: 'whim_snippet_delete', description: 'Delete a snippet.', inputSchema: schema({ name: nameProperty }, ['name']) },
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
    case 'whim_context_set': return backend.contextSet(id('key'), requireString(args, 'text'), namespace())
    case 'whim_context_get': return backend.contextGet(id('key'), namespace())
    case 'whim_context_list': return backend.contextList(namespace())
    case 'whim_context_delete': return backend.contextDelete(id('key'), namespace())
    case 'whim_facts_save': return backend.factsSave(id('name'), requireString(args, 'value'))
    case 'whim_facts_get': return backend.factsGet(id('name'))
    case 'whim_facts_list': return backend.factsList()
    case 'whim_facts_delete': return backend.factsDelete(id('name'))
    case 'whim_plan_save': return backend.planSave(id('name', 'current'), requireString(args, 'plan'))
    case 'whim_plan_get': return backend.planGet(id('name', 'current'))
    case 'whim_plan_list': return backend.planList()
    case 'whim_plan_delete': return backend.planDelete(id('name', 'current'))
    case 'whim_rag_index': return backend.ragIndex(id('id'), requireString(args, 'text'))
    case 'whim_rag_search': return backend.ragSearch(requireString(args, 'query', 10_000), topK(args))
    case 'whim_rag_list': return backend.ragList()
    case 'whim_rag_delete': return backend.ragDelete(id('id'))
    case 'whim_snippet_save': return backend.snippetSave(id('name'), id('language'), requireString(args, 'code'), args.description === undefined ? '' : requireString(args, 'description', 10_000))
    case 'whim_snippet_search': return backend.snippetSearch(requireString(args, 'query', 10_000), topK(args))
    case 'whim_snippet_list': return backend.snippetList()
    case 'whim_snippet_delete': return backend.snippetDelete(id('name'))
    default: throw new Error(`Unknown tool: ${name}`)
  }
}

async function resolveBackend(): Promise<Backend> {
  const storageDir = process.env.WHIMSICALITY_STORAGE_DIR ?? defaultStorageDir()
  const hotBudgetMb = Number(process.env.WHIMSICALITY_HOT_BUDGET_MB ?? '256')
  try {
    const backend = new KernelBackend(storageDir, Number.isFinite(hotBudgetMb) && hotBudgetMb > 0 ? hotBudgetMb : 256)
    await backend.start()
    process.stderr.write('whimsicality-mcp: using Rust kernel backend\n')
    return backend
  } catch (error) {
    process.stderr.write(`whimsicality-mcp: kernel unavailable (${error instanceof Error ? error.message : String(error)}), using disk backend\n`)
    return new DiskBackend(storageDir)
  }
}

async function main(): Promise<void> {
  const backend = await resolveBackend()
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
