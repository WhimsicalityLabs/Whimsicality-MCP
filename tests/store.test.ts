import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'

interface RpcResponse {
  id?: number
  result?: { content?: { text: string }[]; isError?: boolean }
  error?: unknown
}

class McpProcess {
  private readonly child: ChildProcess
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void }>()
  private stderr = ''

  constructor(storageDir: string) {
    this.child = spawn(process.execPath, ['lib/index.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WHIMSICALITY_STORAGE_DIR: storageDir },
    })
    this.child.stdout!.setEncoding('utf-8')
    this.child.stderr!.setEncoding('utf-8')
    this.child.stdout!.on('data', (chunk: string) => this.onData(chunk))
    this.child.stderr!.on('data', (chunk: string) => { this.stderr += chunk })
    this.child.on('exit', () => {
      for (const request of this.pending.values()) request.reject(new Error(`server exited. stderr: ${this.stderr}`))
      this.pending.clear()
    })
  }

  call(method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`no response. stderr: ${this.stderr}`))
      }, 3000)
      this.pending.set(id, {
        resolve: (response) => { clearTimeout(timeout); resolve(response) },
        reject: (error) => { clearTimeout(timeout); reject(error) },
      })
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  stop(): void {
    this.child.kill()
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      const response = JSON.parse(line) as RpcResponse
      if (response.id === undefined) continue
      const request = this.pending.get(response.id)
      if (!request) continue
      this.pending.delete(response.id)
      request.resolve(response)
    }
  }
}

function text(response: RpcResponse): string {
  return response.result?.content?.[0]?.text ?? JSON.stringify(response.error)
}

function parsed<T>(response: RpcResponse): T {
  return JSON.parse(text(response)) as T
}

describe('persistent store', () => {
  let dir: string
  const servers: McpProcess[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'whim-test-'))
  })

  afterEach(() => {
    for (const server of servers) server.stop()
    servers.length = 0
    rmSync(dir, { recursive: true, force: true })
  })

  function server(): McpProcess {
    const process = new McpProcess(dir)
    servers.push(process)
    return process
  }

  it('makes writes immediately visible to an already-running peer', async () => {
    const a = server()
    const b = server()
    await b.call('tools/list', {})
    await a.call('tools/call', { name: 'whim_memory_set', arguments: { key: 'shared', value: 'written-by-a' } })
    expect(text(await b.call('tools/call', { name: 'whim_memory_get', arguments: { key: 'shared' } }))).toContain('written-by-a')
  })

  it('sees same-size writes from another process (mtime/size gate removed)', async () => {
    const a = server()
    const b = server()
    await a.call('tools/call', { name: 'whim_memory_set', arguments: { key: 'k', value: 'AAAAAAAAAA' } })
    expect(text(await b.call('tools/call', { name: 'whim_memory_get', arguments: { key: 'k' } }))).toContain('AAAAAAAAAA')
    await a.call('tools/call', { name: 'whim_memory_set', arguments: { key: 'k', value: 'BBBBBBBBBB' } })
    expect(text(await b.call('tools/call', { name: 'whim_memory_get', arguments: { key: 'k' } }))).toContain('BBBBBBBBBB')
  })

  it('preserves concurrent writes from separate processes', async () => {
    const a = server()
    const b = server()
    await Promise.all([
      a.call('tools/call', { name: 'whim_memory_set', arguments: { key: 'a', value: 'one' } }),
      b.call('tools/call', { name: 'whim_memory_set', arguments: { key: 'b', value: 'two' } }),
    ])
    expect(text(await a.call('tools/call', { name: 'whim_memory_get', arguments: { key: 'b' } }))).toContain('two')
    expect(text(await b.call('tools/call', { name: 'whim_memory_get', arguments: { key: 'a' } }))).toContain('one')
  })

  it('renames corrupt data and remains available', async () => {
    writeFileSync(join(dir, 'whim-mcp-store.json'), '{ "broken json', 'utf-8')
    const response = await server().call('tools/call', { name: 'whim_memory_get', arguments: { key: 'missing' } })
    expect(response.result?.isError).toBe(true)
    expect(readdirSync(dir).some((file) => file.startsWith('whim-mcp-store.json.corrupt-'))).toBe(true)
  })

  it('supports list and delete for memory and docs', async () => {
    const mcp = server()
    await mcp.call('tools/call', { name: 'whim_memory_set', arguments: { key: 'fact1', value: 'value1' } })
    await mcp.call('tools/call', { name: 'whim_doc_save', arguments: { id: 'doc1', text: 'document text' } })

    expect(text(await mcp.call('tools/call', { name: 'whim_memory_list', arguments: {} }))).toContain('fact1')
    expect(text(await mcp.call('tools/call', { name: 'whim_doc_list', arguments: {} }))).toContain('doc1')

    await mcp.call('tools/call', { name: 'whim_memory_delete', arguments: { key: 'fact1' } })
    await mcp.call('tools/call', { name: 'whim_doc_delete', arguments: { id: 'doc1' } })

    expect(parsed<{ keys: string[] }>(await mcp.call('tools/call', { name: 'whim_memory_list', arguments: {} })).keys).toEqual([])
    expect(parsed<{ ids: string[] }>(await mcp.call('tools/call', { name: 'whim_doc_list', arguments: {} })).ids).toEqual([])
  })

  it('delete reports deleted:false for nonexistent keys', async () => {
    const mcp = server()
    const result = parsed<{ deleted: boolean }>(await mcp.call('tools/call', { name: 'whim_memory_delete', arguments: { key: 'nope' } }))
    expect(result.deleted).toBe(false)
    const docResult = parsed<{ deleted: boolean }>(await mcp.call('tools/call', { name: 'whim_doc_delete', arguments: { id: 'nope' } }))
    expect(docResult.deleted).toBe(false)
  })

  it('returns match-centered chunks for long documents', async () => {
    const mcp = server()
    const document = `${'header '.repeat(200)}needle_unique ${'tail '.repeat(200)}`
    await mcp.call('tools/call', { name: 'whim_doc_save', arguments: { id: 'doc', text: document } })
    const result = parsed<{ results: { text: string }[] }>(await mcp.call('tools/call', { name: 'whim_doc_search', arguments: { query: 'needle_unique' } }))
    expect(result.results[0]?.text).toContain('needle_unique')
    expect(result.results[0]?.text.length).toBeLessThanOrEqual(700)
  })

  it('retrieves a full document via doc_get', async () => {
    const mcp = server()
    const document = 'This is the full document text. It is longer than a chunk would be.'
    await mcp.call('tools/call', { name: 'whim_doc_save', arguments: { id: 'design', text: document, language: 'markdown', description: 'design doc' } })
    const result = parsed<{ id: string; text: string; language: string; description: string }>(await mcp.call('tools/call', { name: 'whim_doc_get', arguments: { id: 'design' } }))
    expect(result.id).toBe('design')
    expect(result.text).toBe(document)
    expect(result.language).toBe('markdown')
    expect(result.description).toBe('design doc')
  })

  it('doc_get returns isError for missing documents', async () => {
    const mcp = server()
    const response = await mcp.call('tools/call', { name: 'whim_doc_get', arguments: { id: 'missing' } })
    expect(response.result?.isError).toBe(true)
  })

  it('searches short and punctuation-bearing technical terms', async () => {
    const mcp = server()
    await mcp.call('tools/call', { name: 'whim_doc_save', arguments: { id: 'tech', text: 'AI systems written in Go and C#' } })
    for (const query of ['AI', 'Go', 'C#']) {
      const result = parsed<{ results: { id: string }[] }>(await mcp.call('tools/call', { name: 'whim_doc_search', arguments: { query } }))
      expect(result.results[0]?.id).toBe('tech')
    }
  })

  it('finds sentence-final words despite trailing punctuation', async () => {
    const mcp = server()
    await mcp.call('tools/call', { name: 'whim_doc_save', arguments: { id: 'prose', text: 'The parser handles tooling. Deployment is automated (mostly).' } })
    const result = parsed<{ results: { id: string }[] }>(await mcp.call('tools/call', { name: 'whim_doc_search', arguments: { query: 'tooling' } }))
    expect(result.results[0]?.id).toBe('prose')
  })

  it('BM25 ranks rare terms above common terms', async () => {
    const mcp = server()
    await mcp.call('tools/call', { name: 'whim_doc_save', arguments: { id: 'common', text: 'the system processes the data and the results' } })
    await mcp.call('tools/call', { name: 'whim_doc_save', arguments: { id: 'rare', text: 'the rust kernel provides persistent storage' } })
    const result = parsed<{ results: { id: string; score: number }[] }>(await mcp.call('tools/call', { name: 'whim_doc_search', arguments: { query: 'rust kernel storage' } }))
    expect(result.results[0]?.id).toBe('rare')
  })

  it('validates identifiers, numeric bounds, and input sizes', async () => {
    const mcp = server()
    const badKey = await mcp.call('tools/call', { name: 'whim_memory_set', arguments: { key: `bad\u001fkey`, value: 'x' } })
    const badTopK = await mcp.call('tools/call', { name: 'whim_doc_search', arguments: { query: 'x', topK: 0 } })
    const tooLarge = await mcp.call('tools/call', { name: 'whim_memory_set', arguments: { key: 'x', value: 'a'.repeat(1_000_001) } })
    expect(badKey.result?.isError).toBe(true)
    expect(badTopK.result?.isError).toBe(true)
    expect(tooLarge.result?.isError).toBe(true)
  })

  it('requires key on memory_delete (no default to prevent data loss)', async () => {
    const mcp = server()
    await mcp.call('tools/call', { name: 'whim_memory_set', arguments: { key: 'keep', value: 'val' } })
    const noKey = await mcp.call('tools/call', { name: 'whim_memory_delete', arguments: {} })
    expect(noKey.result?.isError).toBe(true)
    expect(text(await mcp.call('tools/call', { name: 'whim_memory_get', arguments: { key: 'keep' } }))).toContain('val')
  })

  it('not-found reads return isError consistently', async () => {
    const mcp = server()
    const memResult = await mcp.call('tools/call', { name: 'whim_memory_get', arguments: { key: 'nope' } })
    expect(memResult.result?.isError).toBe(true)
  })

  it('failed writes do not poison the cache', async () => {
    const mcp = server()
    await mcp.call('tools/call', { name: 'whim_memory_set', arguments: { key: 'real', value: 'real-value' } })
    const tooLarge = await mcp.call('tools/call', { name: 'whim_memory_set', arguments: { key: 'real', value: 'a'.repeat(1_000_001) } })
    expect(tooLarge.result?.isError).toBe(true)
    expect(text(await mcp.call('tools/call', { name: 'whim_memory_get', arguments: { key: 'real' } }))).toContain('real-value')
  })

  it('migrates legacy 0.3.0 data (context/facts/plans/snippets) into memory', async () => {
    const legacy = {
      context: { 'default\x1fold': { value: 'ctx-val', createdAt: '', updatedAt: '' } },
      facts: { fact1: { value: 'fact-val', createdAt: '', updatedAt: '' } },
      plans: { current: { value: 'plan-val', createdAt: '', updatedAt: '' } },
      snippets: { snip: { value: 'code-val', name: 'snip', language: 'ts', description: '', createdAt: '', updatedAt: '' } },
      docs: {},
    }
    writeFileSync(join(dir, 'whim-mcp-store.json'), JSON.stringify(legacy), 'utf-8')
    const mcp = server()
    expect(text(await mcp.call('tools/call', { name: 'whim_memory_get', arguments: { key: 'fact1', namespace: 'facts' } }))).toContain('fact-val')
    expect(text(await mcp.call('tools/call', { name: 'whim_memory_get', arguments: { key: 'current', namespace: 'plans' } }))).toContain('plan-val')
  })
})
