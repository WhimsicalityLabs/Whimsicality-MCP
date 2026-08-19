#!/usr/bin/env node
/**
 * Whimsicality MCP Server — a standalone stdio MCP server that gives AI agents
 * persistent memory, RAG search, facts, plans, and snippet storage.
 *
 * Works with any MCP-compatible agent (Devin CLI, Claude Desktop, etc.) and
 * persists data across sessions and processes.
 *
 * ## Backends
 *
 * 1. **Rust kernel** (optional): tiered storage (RAM/mmap/zstd), content-addressed
 *    dedup, append-only session log. Best performance and features.
 * 2. **Disk fallback** (default): JSON-file persistence. Works out of the box
 *    with zero native dependencies. Data survives across processes.
 *
 * When the kernel is available, writes go to both kernel and disk (dual-write)
 * so data persists even if the kernel's hot tier is lost on process exit.
 *
 * @module whimsicality-mcp
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { KernelClient, defaultStorageDir } from './kernel-client.js'

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

interface Backend {
  contextSet(key: string, text: string, namespace: string): Promise<unknown>
  contextGet(key: string, namespace: string): Promise<unknown>
  contextList(namespace: string): Promise<unknown>
  contextDelete(key: string, namespace: string): Promise<unknown>
  ragSearch(query: string, topK: number): Promise<unknown>
  ragIndex(id: string, text: string): Promise<unknown>
  factsSave(name: string, value: string): Promise<unknown>
  factsGet(name: string): Promise<unknown>
  factsList(): Promise<unknown>
  planSave(name: string, plan: string): Promise<unknown>
  planGet(name: string): Promise<unknown>
  snippetSave(name: string, language: string, code: string, description: string): Promise<unknown>
  snippetSearch(query: string, topK: number): Promise<unknown>
  compact(messages: string[], maxTokens: number): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Disk store — JSON-file persistence
// ---------------------------------------------------------------------------

interface Snippet {
  name: string
  language: string
  code: string
  description: string
}

interface IndexedDoc {
  id: string
  text: string
}

interface DiskData {
  context: Record<string, string>
  facts: Record<string, string>
  plans: Record<string, string>
  snippets: Record<string, Snippet>
  docs: Record<string, IndexedDoc>
}

/** Word-overlap similarity score in [0, 1]. */
function textSimilarity(query: string, text: string): number {
  const queryWords = new Set(query.split(/\s+/).filter((w) => w.length > 2))
  if (queryWords.size === 0) return 0
  let hits = 0
  for (const word of queryWords) {
    if (text.includes(word)) hits++
  }
  return hits / queryWords.size
}

/**
 * JSON-file-backed store. Persists all data to a single file on disk so
 * state survives across MCP server processes.
 */
class DiskStore {
  private data: DiskData
  private readonly filePath: string

  constructor(storageDir: string) {
    mkdirSync(storageDir, { recursive: true })
    this.filePath = join(storageDir, 'whim-mcp-store.json')
    this.data = this.load()
  }

  private load(): DiskData {
    if (existsSync(this.filePath)) {
      try {
        const raw = readFileSync(this.filePath, 'utf-8')
        const parsed = JSON.parse(raw) as Partial<DiskData>
        return {
          context: parsed.context ?? {},
          facts: parsed.facts ?? {},
          plans: parsed.plans ?? {},
          snippets: parsed.snippets ?? {},
          docs: parsed.docs ?? {},
        }
      } catch {
        // Corrupt file — start fresh.
      }
    }
    return { context: {}, facts: {}, plans: {}, snippets: {}, docs: {} }
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
  }

  contextSet(ns: string, key: string, text: string): void {
    this.data.context[`${ns}.${key}`] = text
    this.save()
  }
  contextGet(ns: string, key: string): string | null {
    return this.data.context[`${ns}.${key}`] ?? null
  }
  contextList(ns: string): string[] {
    const prefix = `${ns}.`
    return Object.keys(this.data.context)
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
  }
  contextDelete(ns: string, key: string): void {
    delete this.data.context[`${ns}.${key}`]
    this.save()
  }
  factsSave(name: string, value: string): void {
    this.data.facts[name] = value
    this.save()
  }
  factsGet(name: string): string | null {
    return this.data.facts[name] ?? null
  }
  factsList(): string[] {
    return Object.keys(this.data.facts)
  }
  planSave(name: string, plan: string): void {
    this.data.plans[name] = plan
    this.save()
  }
  planGet(name: string): string | null {
    return this.data.plans[name] ?? null
  }
  ragIndex(id: string, text: string): void {
    this.data.docs[id] = { id, text }
    this.save()
  }
  ragSearch(query: string, topK: number): { id: string; score: number; text: string }[] {
    const queryLower = query.toLowerCase()
    return Object.values(this.data.docs)
      .map((doc) => ({
        id: doc.id,
        score: textSimilarity(queryLower, doc.text.toLowerCase()),
        text: doc.text.slice(0, 500),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }
  snippetSave(name: string, language: string, code: string, description: string): void {
    this.data.snippets[name] = { name, language, code, description }
    this.save()
  }
  snippetSearch(query: string, topK: number): (Snippet & { score: number })[] {
    const queryLower = query.toLowerCase()
    return Object.values(this.data.snippets)
      .map((s) => ({
        ...s,
        score: textSimilarity(queryLower, `${s.name} ${s.language} ${s.description} ${s.code}`.toLowerCase()),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }
}

// ---------------------------------------------------------------------------
// Disk-persisted fallback backend (no kernel)
// ---------------------------------------------------------------------------

class DiskBackend implements Backend {
  private readonly store: DiskStore

  constructor(storageDir: string) {
    this.store = new DiskStore(storageDir)
  }

  async contextSet(key: string, text: string, namespace: string): Promise<unknown> {
    this.store.contextSet(namespace, key, text)
    return { stored: true }
  }
  async contextGet(key: string, namespace: string): Promise<unknown> {
    const text = this.store.contextGet(namespace, key)
    return text !== null ? { text } : { text: null, error: 'not found' }
  }
  async contextList(namespace: string): Promise<unknown> {
    return { keys: this.store.contextList(namespace) }
  }
  async contextDelete(key: string, namespace: string): Promise<unknown> {
    this.store.contextDelete(namespace, key)
    return { deleted: true }
  }
  async ragSearch(query: string, topK: number): Promise<unknown> {
    return { results: this.store.ragSearch(query, topK) }
  }
  async ragIndex(id: string, text: string): Promise<unknown> {
    this.store.ragIndex(id, text)
    return { indexed: true }
  }
  async factsSave(name: string, value: string): Promise<unknown> {
    this.store.factsSave(name, value)
    return { saved: true }
  }
  async factsGet(name: string): Promise<unknown> {
    const value = this.store.factsGet(name)
    return value !== null ? { name, value } : { name, value: null, error: 'not found' }
  }
  async factsList(): Promise<unknown> {
    return { names: this.store.factsList() }
  }
  async planSave(name: string, plan: string): Promise<unknown> {
    this.store.planSave(name, plan)
    return { saved: true }
  }
  async planGet(name: string): Promise<unknown> {
    const plan = this.store.planGet(name)
    return plan !== null ? { plan } : { plan: null, error: 'not found' }
  }
  async snippetSave(name: string, language: string, code: string, description: string): Promise<unknown> {
    this.store.snippetSave(name, language, code, description)
    return { saved: true }
  }
  async snippetSearch(query: string, topK: number): Promise<unknown> {
    return { results: this.store.snippetSearch(query, topK) }
  }
  async compact(messages: string[], maxTokens: number): Promise<unknown> {
    if (messages.length <= 2) return { summary: messages.join('\n'), originalCount: messages.length }
    const head = messages[0]!
    const tail = messages[messages.length - 1]!
    const middle = messages.slice(1, -1).join('\n')
    const middleSummary = middle.slice(0, maxTokens * 4)
    return {
      summary: `${head}\n\n[... ${messages.length - 2} messages compacted ...]\n\n${middleSummary}\n\n${tail}`,
      originalCount: messages.length,
    }
  }
}

// ---------------------------------------------------------------------------
// Kernel backend (dual-write: kernel + disk)
// ---------------------------------------------------------------------------

/**
 * Kernel backend — used when the Rust binary is available.
 *
 * Writes go to both the kernel (fast in-session tiered storage) and the
 * disk store (cross-session persistence). Reads try the kernel first,
 * then fall back to disk.
 */
class KernelBackend implements Backend {
  private kernel: KernelClient | null = null
  private readonly disk: DiskStore

  constructor(
    private readonly storageDir: string,
    private readonly hotBudgetMb: number,
  ) {
    this.disk = new DiskStore(join(storageDir, 'mcp-aux'))
  }

  async start(): Promise<void> {
    this.kernel = new KernelClient({
      storageDir: this.storageDir,
      hotBudgetMb: this.hotBudgetMb,
      autoRestart: true,
    })
    await this.kernel.start()
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.kernel === null) throw new Error('kernel not started')
    return this.kernel.call(method, params)
  }

  async contextSet(key: string, text: string, namespace: string): Promise<unknown> {
    await this.call('kernel.set_text', { id: `${namespace}.${key}`, text, kind: 'reasoning' })
    this.disk.contextSet(namespace, key, text)
    return { stored: true }
  }

  async contextGet(key: string, namespace: string): Promise<unknown> {
    try {
      const result = await this.call('kernel.get_text', { id: `${namespace}.${key}` }) as { text: string | null }
      if (result.text !== null && result.text !== undefined) return { text: result.text }
    } catch { /* fall through to disk */ }
    const text = this.disk.contextGet(namespace, key)
    return text !== null ? { text } : { text: null, error: 'not found' }
  }

  async contextList(namespace: string): Promise<unknown> {
    const kernelIds = await this.call('kernel.list', { namespace }) as { ids: string[] }
    const prefix = `${namespace}.`
    const kernelKeys = (kernelIds.ids ?? []).map((id) =>
      id.startsWith(prefix) ? id.slice(prefix.length) : id,
    )
    const diskKeys = this.disk.contextList(namespace)
    return { keys: [...new Set([...kernelKeys, ...diskKeys])] }
  }

  async contextDelete(key: string, namespace: string): Promise<unknown> {
    try { await this.call('kernel.delete', { id: `${namespace}.${key}` }) } catch { /* still delete from disk */ }
    this.disk.contextDelete(namespace, key)
    return { deleted: true }
  }

  async factsSave(name: string, value: string): Promise<unknown> {
    await this.call('kernel.set_text', { id: `facts.${name}`, text: value, kind: 'reasoning' })
    this.disk.factsSave(name, value)
    return { saved: true }
  }

  async factsGet(name: string): Promise<unknown> {
    try {
      const result = await this.call('kernel.get_text', { id: `facts.${name}` }) as { text: string | null }
      if (result.text !== null && result.text !== undefined) return { name, value: result.text }
    } catch { /* fall through to disk */ }
    const value = this.disk.factsGet(name)
    return value !== null ? { name, value } : { name, value: null, error: 'not found' }
  }

  async factsList(): Promise<unknown> {
    const kernelResult = await this.call('kernel.list', { namespace: 'facts' }) as { ids: string[] }
    const kernelNames = (kernelResult.ids ?? []).map((id) => id.replace(/^facts\./, ''))
    const diskNames = this.disk.factsList()
    return { names: [...new Set([...kernelNames, ...diskNames])] }
  }

  async planSave(name: string, plan: string): Promise<unknown> {
    await this.call('kernel.set_text', { id: `plan.${name}`, text: plan, kind: 'summary' })
    this.disk.planSave(name, plan)
    return { saved: true }
  }

  async planGet(name: string): Promise<unknown> {
    try {
      const result = await this.call('kernel.get_text', { id: `plan.${name}` }) as { text: string | null }
      if (result.text !== null && result.text !== undefined) return { plan: result.text }
    } catch { /* fall through to disk */ }
    const plan = this.disk.planGet(name)
    return plan !== null ? { plan } : { plan: null, error: 'not found' }
  }

  async ragSearch(query: string, topK: number): Promise<unknown> {
    return { results: this.disk.ragSearch(query, topK) }
  }
  async ragIndex(id: string, text: string): Promise<unknown> {
    this.disk.ragIndex(id, text)
    return { indexed: true }
  }
  async snippetSave(name: string, language: string, code: string, description: string): Promise<unknown> {
    this.disk.snippetSave(name, language, code, description)
    return { saved: true }
  }
  async snippetSearch(query: string, topK: number): Promise<unknown> {
    return { results: this.disk.snippetSearch(query, topK) }
  }
  async compact(messages: string[], maxTokens: number): Promise<unknown> {
    if (messages.length <= 2) return { summary: messages.join('\n'), originalCount: messages.length }
    const head = messages[0]!
    const tail = messages[messages.length - 1]!
    const middle = messages.slice(1, -1).join('\n')
    const middleSummary = middle.slice(0, maxTokens * 4)
    return {
      summary: `${head}\n\n[... ${messages.length - 2} messages compacted ...]\n\n${middleSummary}\n\n${tail}`,
      originalCount: messages.length,
    }
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] }
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'whim_context_set',
    description: 'Store text in a named context slot. Use for persistent memory that survives across agent sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Context slot name (e.g., "project_state", "user_prefs")' },
        text: { type: 'string', description: 'The text to store' },
        namespace: { type: 'string', description: 'Optional namespace (default: "default")' },
      },
      required: ['key', 'text'],
    },
  },
  {
    name: 'whim_context_get',
    description: 'Retrieve text from a named context slot.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Context slot name' },
        namespace: { type: 'string', description: 'Optional namespace (default: "default")' },
      },
      required: ['key'],
    },
  },
  {
    name: 'whim_context_list',
    description: 'List all context slot keys.',
    inputSchema: {
      type: 'object',
      properties: { namespace: { type: 'string', description: 'Optional namespace (default: "default")' } },
      required: [],
    },
  },
  {
    name: 'whim_context_delete',
    description: 'Delete a context slot.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Context slot name' },
        namespace: { type: 'string', description: 'Optional namespace (default: "default")' },
      },
      required: ['key'],
    },
  },
  {
    name: 'whim_rag_search',
    description: 'Search indexed documents by semantic similarity. Returns relevant chunks ranked by score.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text' },
        topK: { type: 'number', description: 'Number of results (default: 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'whim_rag_index',
    description: 'Index a document for RAG retrieval.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document ID' },
        text: { type: 'string', description: 'Document text to index' },
      },
      required: ['id', 'text'],
    },
  },
  {
    name: 'whim_facts_save',
    description: 'Save a named fact. Facts are key-value pairs that persist across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Fact name (e.g., "user_name", "project_language")' },
        value: { type: 'string', description: 'Fact value' },
      },
      required: ['name', 'value'],
    },
  },
  {
    name: 'whim_facts_get',
    description: 'Retrieve a named fact.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Fact name' } },
      required: ['name'],
    },
  },
  {
    name: 'whim_facts_list',
    description: 'List all saved fact names.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'whim_plan_save',
    description: 'Save a plan document. The plan persists across sessions and can be retrieved later by another agent.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'Plan text (markdown, CGS, or any format)' },
        name: { type: 'string', description: 'Plan slot name (default: "current")' },
      },
      required: ['plan'],
    },
  },
  {
    name: 'whim_plan_get',
    description: 'Retrieve a saved plan.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Plan slot name (default: "current")' } },
      required: [],
    },
  },
  {
    name: 'whim_snippet_save',
    description: 'Save a reusable code snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Snippet name' },
        language: { type: 'string', description: 'Programming language' },
        code: { type: 'string', description: 'Snippet code' },
        description: { type: 'string', description: 'Optional description' },
      },
      required: ['name', 'language', 'code'],
    },
  },
  {
    name: 'whim_snippet_search',
    description: 'Search saved snippets by query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        topK: { type: 'number', description: 'Number of results (default: 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'whim_compact',
    description: 'Compact conversation history into a compressed summary.',
    inputSchema: {
      type: 'object',
      properties: {
        messages: { type: 'array', items: { type: 'string' }, description: 'Messages to compact' },
        maxTokens: { type: 'number', description: 'Target token budget for the summary' },
      },
      required: ['messages'],
    },
  },
] as const

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatch(backend: Backend, name: string, args: Record<string, unknown>): Promise<unknown> {
  const ns = (args['namespace'] as string | undefined) ?? 'default'
  switch (name) {
    case 'whim_context_set': return backend.contextSet(args['key'] as string, args['text'] as string, ns)
    case 'whim_context_get': return backend.contextGet(args['key'] as string, ns)
    case 'whim_context_list': return backend.contextList(ns)
    case 'whim_context_delete': return backend.contextDelete(args['key'] as string, ns)
    case 'whim_rag_search': return backend.ragSearch(args['query'] as string, (args['topK'] as number | undefined) ?? 5)
    case 'whim_rag_index': return backend.ragIndex(args['id'] as string, args['text'] as string)
    case 'whim_facts_save': return backend.factsSave(args['name'] as string, args['value'] as string)
    case 'whim_facts_get': return backend.factsGet(args['name'] as string)
    case 'whim_facts_list': return backend.factsList()
    case 'whim_plan_save': return backend.planSave((args['name'] as string | undefined) ?? 'current', args['plan'] as string)
    case 'whim_plan_get': return backend.planGet((args['name'] as string | undefined) ?? 'current')
    case 'whim_snippet_save': return backend.snippetSave(args['name'] as string, args['language'] as string, args['code'] as string, (args['description'] as string | undefined) ?? '')
    case 'whim_snippet_search': return backend.snippetSearch(args['query'] as string, (args['topK'] as number | undefined) ?? 5)
    case 'whim_compact': return backend.compact(args['messages'] as string[], (args['maxTokens'] as number | undefined) ?? 4096)
    default: throw new Error(`Unknown tool: ${name}`)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function resolveBackend(): Promise<Backend> {
  const storageDir = process.env['WHIMSICALITY_STORAGE_DIR'] ?? defaultStorageDir()
  const hotBudgetMb = Number(process.env['WHIMSICALITY_HOT_BUDGET_MB'] ?? '256')

  try {
    const kernel = new KernelBackend(storageDir, hotBudgetMb)
    await kernel.start()
    process.stderr.write('whimsicality-mcp: using Rust kernel backend\n')
    return kernel
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    process.stderr.write(`whimsicality-mcp: kernel unavailable (${msg}), using disk-persisted backend\n`)
    return new DiskBackend(storageDir)
  }
}

async function main(): Promise<void> {
  const backend = await resolveBackend()

  const server = new Server(
    { name: 'whimsicality-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    try {
      const result = await dispatch(backend, name, (args ?? {}) as Record<string, unknown>)
      return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`whimsicality-mcp: fatal: ${message}\n`)
  process.exit(1)
})
