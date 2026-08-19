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
 * Both backends share the same disk store path, so data remains visible
 * regardless of whether the kernel is present on a given run.
 *
 * RAG, snippets, and compaction are disk-only — the kernel does not implement
 * those operations.
 *
 * @module whimsicality-mcp
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
} from 'node:fs'
import { join } from 'node:path'
import { KernelClient, defaultStorageDir } from './kernel-client.js'
import pkg from '../package.json' with { type: 'json' }

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
// Disk store — JSON-file persistence with atomic writes and locking
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

const EMPTY_DATA: DiskData = { context: {}, facts: {}, plans: {}, snippets: {}, docs: {} }

/** Separator used to join namespace and key. The `\x1f` ASCII unit separator cannot appear in user-supplied strings. */
const NS_SEP = '\x1f'

/** Join a namespace and key into a storage key using a separator that cannot collide. */
function nsKey(ns: string, key: string): string {
  return `${ns}${NS_SEP}${key}`
}

/** Word-boundary overlap similarity score in [0, 1]. Substring matches like "cat" in "category" do not count. */
function textSimilarity(query: string, text: string): number {
  const queryWords = new Set(query.split(/\s+/).filter((w) => w.length > 2))
  if (queryWords.size === 0) return 0
  let hits = 0
  for (const word of queryWords) {
    const re = new RegExp(`\\b${escapeRegex(word)}\\b`, 'i')
    if (re.test(text)) hits++
  }
  return hits / queryWords.size
}

/** Escape a string for use inside a RegExp. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * JSON-file-backed store. Persists all data to a single file on disk so
 * state survives across MCP server processes.
 *
 * Writes are atomic (write to `.tmp` then rename) and guarded by an advisory
 * lockfile to prevent concurrent processes from clobbering each other. Each
 * mutation re-reads the file from disk before applying the change, so two
 * server processes running simultaneously do not lose data.
 */
class DiskStore {
  private data: DiskData
  private readonly filePath: string
  private readonly tmpPath: string
  private readonly lockPath: string

  constructor(storageDir: string) {
    mkdirSync(storageDir, { recursive: true })
    this.filePath = join(storageDir, 'whim-mcp-store.json')
    this.tmpPath = `${this.filePath}.tmp`
    this.lockPath = `${this.filePath}.lock`
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
      } catch (err) {
        // Rename the corrupt file so the user can inspect or recover it, then start fresh.
        const corruptPath = `${this.filePath}.corrupt-${Date.now()}`
        try { renameSync(this.filePath, corruptPath) } catch { /* rename may fail on some platforms */ }
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`whimsicality-mcp: corrupt store file renamed to ${corruptPath} (${msg}); starting fresh\n`)
      }
    }
    return { ...EMPTY_DATA }
  }

  /** Acquire an advisory lock, run a mutation against freshly-read disk data, write atomically, release. */
  private withLock<T>(mutate: (data: DiskData) => T): T {
    this.acquireLock()
    try {
      // Re-read from disk so concurrent writes by other processes are not lost.
      const fresh = this.load()
      const result = mutate(fresh)
      this.data = fresh
      // Atomic write: write to .tmp then rename.
      writeFileSync(this.tmpPath, JSON.stringify(fresh, null, 2), 'utf-8')
      renameSync(this.tmpPath, this.filePath)
      return result
    } finally {
      this.releaseLock()
    }
  }

  /** Acquire the advisory lockfile, retrying with backoff. Steals stale locks from dead processes. */
  private acquireLock(): void {
    const maxAttempts = 50
    const baseDelay = 10
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const fd = openSync(this.lockPath, 'wx')
        closeSync(fd)
        writeFileSync(this.lockPath, String(process.pid), 'utf-8')
        return
      } catch (err) {
        // Lock exists — check if the holder is still alive.
        if (existsSync(this.lockPath)) {
          try {
            const pidStr = readFileSync(this.lockPath, 'utf-8').trim()
            const pid = Number(pidStr)
            if (pid && !isProcessAlive(pid)) {
              // Stale lock — steal it.
              try { unlinkSync(this.lockPath) } catch { /* race */ }
              continue
            }
          } catch { /* read failed — try to steal */ }
        }
        const delay = baseDelay * Math.pow(1.5, Math.min(attempt, 10))
        // Busy-wait is acceptable for short critical sections.
        const end = Date.now() + delay
        while (Date.now() < end) { /* spin */ }
      }
    }
    // Could not acquire after all attempts — proceed anyway (best-effort, better than hanging).
    process.stderr.write('whimsicality-mcp: could not acquire store lock after retries; proceeding without lock\n')
  }

  private releaseLock(): void {
    try { unlinkSync(this.lockPath) } catch { /* already gone */ }
  }

  // -- context (namespace\x1fkey → text) --

  contextSet(ns: string, key: string, text: string): void {
    this.withLock((d) => { d.context[nsKey(ns, key)] = text })
  }

  contextGet(ns: string, key: string): string | null {
    return this.data.context[nsKey(ns, key)] ?? null
  }

  contextList(ns: string): string[] {
    const prefix = `${ns}${NS_SEP}`
    return Object.keys(this.data.context)
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
  }

  contextDelete(ns: string, key: string): void {
    this.withLock((d) => { delete d.context[nsKey(ns, key)] })
  }

  // -- facts --

  factsSave(name: string, value: string): void {
    this.withLock((d) => { d.facts[name] = value })
  }

  factsGet(name: string): string | null {
    return this.data.facts[name] ?? null
  }

  factsList(): string[] {
    return Object.keys(this.data.facts)
  }

  // -- plans --

  planSave(name: string, plan: string): void {
    this.withLock((d) => { d.plans[name] = plan })
  }

  planGet(name: string): string | null {
    return this.data.plans[name] ?? null
  }

  // -- RAG --

  ragIndex(id: string, text: string): void {
    this.withLock((d) => { d.docs[id] = { id, text } })
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

  // -- snippets --

  snippetSave(name: string, language: string, code: string, description: string): void {
    this.withLock((d) => { d.snippets[name] = { name, language, code, description } })
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

/** Check if a process with the given PID is alive (best-effort, platform-agnostic). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
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
    return truncateMessages(messages, maxTokens)
  }
}

// ---------------------------------------------------------------------------
// Kernel backend (dual-write: kernel + disk, same disk path as fallback)
// ---------------------------------------------------------------------------

/**
 * Kernel backend — used when the Rust binary is available.
 *
 * Writes go to both the kernel (fast in-session tiered storage) and the
 * disk store (cross-session persistence). Reads try the kernel first,
 * then fall back to disk.
 *
 * The disk store uses the same path as `DiskBackend` so data remains
 * visible whether or not the kernel is present on a given run.
 */
class KernelBackend implements Backend {
  private kernel: KernelClient | null = null
  private readonly disk: DiskStore

  constructor(
    private readonly storageDir: string,
    private readonly hotBudgetMb: number,
  ) {
    this.disk = new DiskStore(storageDir)
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
    let kernelKeys: string[] = []
    try {
      const kernelIds = await this.call('kernel.list', { namespace }) as { ids: string[] }
      const prefix = `${namespace}.`
      kernelKeys = (kernelIds.ids ?? []).map((id) =>
        id.startsWith(prefix) ? id.slice(prefix.length) : id,
      )
    } catch { /* kernel error — return disk keys only */ }
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
    let kernelNames: string[] = []
    try {
      const kernelResult = await this.call('kernel.list', { namespace: 'facts' }) as { ids: string[] }
      kernelNames = (kernelResult.ids ?? []).map((id) => id.replace(/^facts\./, ''))
    } catch { /* kernel error — return disk names only */ }
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

  // RAG / snippets / compaction: the kernel does not implement these → disk only.
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
    return truncateMessages(messages, maxTokens)
  }
}

/**
 * Truncate conversation history to fit within a token budget.
 * Keeps the first and last messages intact, truncates the middle to fit.
 * This is truncation, not summarization — the middle content is cut, not condensed.
 */
function truncateMessages(messages: string[], maxTokens: number): { summary: string; originalCount: number; truncated: boolean } {
  if (messages.length <= 2) {
    return { summary: messages.join('\n'), originalCount: messages.length, truncated: false }
  }
  const head = messages[0]!
  const tail = messages[messages.length - 1]!
  const middle = messages.slice(1, -1).join('\n')
  const maxChars = maxTokens * 4
  if (middle.length <= maxChars) {
    return {
      summary: `${head}\n\n${middle}\n\n${tail}`,
      originalCount: messages.length,
      truncated: false,
    }
  }
  const truncatedMiddle = middle.slice(0, maxChars)
  return {
    summary: `${head}\n\n[... ${messages.length - 2} messages truncated to ${maxTokens} tokens ...]\n\n${truncatedMiddle}\n\n${tail}`,
    originalCount: messages.length,
    truncated: true,
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
        key: { type: 'string', description: 'Context slot name (e.g., "project_state", "user_prefs"). Must not contain dots.' },
        text: { type: 'string', description: 'The text to store' },
        namespace: { type: 'string', description: 'Optional namespace (default: "default"). Must not contain dots.' },
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
    description: 'Search indexed documents by keyword overlap. Returns relevant chunks ranked by word-boundary match score.',
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
    description: 'Index a document for keyword search retrieval.',
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
    description: 'Search saved snippets by keyword overlap.',
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
    description: 'Truncate conversation history to fit a token budget. Keeps first and last messages intact, truncates the middle. This is truncation, not summarization.',
    inputSchema: {
      type: 'object',
      properties: {
        messages: { type: 'array', items: { type: 'string' }, description: 'Messages to truncate' },
        maxTokens: { type: 'number', description: 'Target token budget for the output (default: 4096)' },
      },
      required: ['messages'],
    },
  },
] as const

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/** Validate that a required string argument is present and non-empty. */
function requireString(args: Record<string, unknown>, name: string): string {
  const val = args[name]
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`Missing or invalid required argument: "${name}" (expected non-empty string)`)
  }
  return val
}

/** Validate that a namespace does not contain the separator character or dots. */
function validateNamespace(ns: string): string {
  if (ns.includes(NS_SEP)) {
    throw new Error(`Namespace must not contain the character U+001F (unit separator): got "${ns}"`)
  }
  return ns
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatch(backend: Backend, name: string, args: Record<string, unknown>): Promise<unknown> {
  const ns = validateNamespace((args['namespace'] as string | undefined) ?? 'default')
  switch (name) {
    case 'whim_context_set':
      return backend.contextSet(requireString(args, 'key'), requireString(args, 'text'), ns)
    case 'whim_context_get':
      return backend.contextGet(requireString(args, 'key'), ns)
    case 'whim_context_list':
      return backend.contextList(ns)
    case 'whim_context_delete':
      return backend.contextDelete(requireString(args, 'key'), ns)
    case 'whim_rag_search':
      return backend.ragSearch(requireString(args, 'query'), (args['topK'] as number | undefined) ?? 5)
    case 'whim_rag_index':
      return backend.ragIndex(requireString(args, 'id'), requireString(args, 'text'))
    case 'whim_facts_save':
      return backend.factsSave(requireString(args, 'name'), requireString(args, 'value'))
    case 'whim_facts_get':
      return backend.factsGet(requireString(args, 'name'))
    case 'whim_facts_list':
      return backend.factsList()
    case 'whim_plan_save':
      return backend.planSave((args['name'] as string | undefined) ?? 'current', requireString(args, 'plan'))
    case 'whim_plan_get':
      return backend.planGet((args['name'] as string | undefined) ?? 'current')
    case 'whim_snippet_save':
      return backend.snippetSave(
        requireString(args, 'name'),
        requireString(args, 'language'),
        requireString(args, 'code'),
        (args['description'] as string | undefined) ?? '',
      )
    case 'whim_snippet_search':
      return backend.snippetSearch(requireString(args, 'query'), (args['topK'] as number | undefined) ?? 5)
    case 'whim_compact': {
      const messages = args['messages']
      if (!Array.isArray(messages) || messages.some((m) => typeof m !== 'string')) {
        throw new Error('Missing or invalid required argument: "messages" (expected string array)')
      }
      return backend.compact(messages as string[], (args['maxTokens'] as number | undefined) ?? 4096)
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
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
    { name: 'whimsicality-mcp', version: pkg.version },
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
