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
      env: { ...process.env, WHIMSICALITY_STORAGE_DIR: storageDir, WHIMSICALITY_KERNEL_BIN: '/nonexistent' },
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
    await a.call('tools/call', { name: 'whim_facts_save', arguments: { name: 'shared', value: 'written-by-a' } })
    expect(text(await b.call('tools/call', { name: 'whim_facts_get', arguments: { name: 'shared' } }))).toContain('written-by-a')
  })

  it('preserves concurrent writes from separate processes', async () => {
    const a = server()
    const b = server()
    await Promise.all([
      a.call('tools/call', { name: 'whim_facts_save', arguments: { name: 'a', value: 'one' } }),
      b.call('tools/call', { name: 'whim_facts_save', arguments: { name: 'b', value: 'two' } }),
    ])
    expect(text(await a.call('tools/call', { name: 'whim_facts_get', arguments: { name: 'b' } }))).toContain('two')
    expect(text(await b.call('tools/call', { name: 'whim_facts_get', arguments: { name: 'a' } }))).toContain('one')
  })

  it('renames corrupt data and remains available', async () => {
    writeFileSync(join(dir, 'whim-mcp-store.json'), '{ "broken json', 'utf-8')
    const response = await server().call('tools/call', { name: 'whim_facts_get', arguments: { name: 'missing' } })
    expect(text(response)).toContain('not found')
    expect(readdirSync(dir).some((file) => file.startsWith('whim-mcp-store.json.corrupt-'))).toBe(true)
  })

  it('supports list and delete for every persisted collection', async () => {
    const mcp = server()
    await mcp.call('tools/call', { name: 'whim_facts_save', arguments: { name: 'fact', value: 'value' } })
    await mcp.call('tools/call', { name: 'whim_plan_save', arguments: { name: 'plan', plan: 'steps' } })
    await mcp.call('tools/call', { name: 'whim_snippet_save', arguments: { name: 'snippet', language: 'ts', code: 'const x = 1' } })
    await mcp.call('tools/call', { name: 'whim_rag_index', arguments: { id: 'doc', text: 'document' } })

    expect(text(await mcp.call('tools/call', { name: 'whim_facts_list', arguments: {} }))).toContain('fact')
    expect(text(await mcp.call('tools/call', { name: 'whim_plan_list', arguments: {} }))).toContain('plan')
    expect(text(await mcp.call('tools/call', { name: 'whim_snippet_list', arguments: {} }))).toContain('snippet')
    expect(text(await mcp.call('tools/call', { name: 'whim_rag_list', arguments: {} }))).toContain('doc')

    await mcp.call('tools/call', { name: 'whim_facts_delete', arguments: { name: 'fact' } })
    await mcp.call('tools/call', { name: 'whim_plan_delete', arguments: { name: 'plan' } })
    await mcp.call('tools/call', { name: 'whim_snippet_delete', arguments: { name: 'snippet' } })
    await mcp.call('tools/call', { name: 'whim_rag_delete', arguments: { id: 'doc' } })

    expect(parsed<{ names: string[] }>(await mcp.call('tools/call', { name: 'whim_facts_list', arguments: {} })).names).toEqual([])
    expect(parsed<{ names: string[] }>(await mcp.call('tools/call', { name: 'whim_plan_list', arguments: {} })).names).toEqual([])
    expect(parsed<{ names: string[] }>(await mcp.call('tools/call', { name: 'whim_snippet_list', arguments: {} })).names).toEqual([])
    expect(parsed<{ ids: string[] }>(await mcp.call('tools/call', { name: 'whim_rag_list', arguments: {} })).ids).toEqual([])
  })

  it('returns match-centered chunks for long documents', async () => {
    const mcp = server()
    const document = `${'header '.repeat(200)}needle_unique ${'tail '.repeat(200)}`
    await mcp.call('tools/call', { name: 'whim_rag_index', arguments: { id: 'doc', text: document } })
    const result = parsed<{ results: { text: string }[] }>(await mcp.call('tools/call', { name: 'whim_rag_search', arguments: { query: 'needle_unique' } }))
    expect(result.results[0]?.text).toContain('needle_unique')
    expect(result.results[0]?.text.length).toBeLessThanOrEqual(700)
  })

  it('searches short and punctuation-bearing technical terms', async () => {
    const mcp = server()
    await mcp.call('tools/call', { name: 'whim_rag_index', arguments: { id: 'tech', text: 'AI systems written in Go and C#' } })
    for (const query of ['AI', 'Go', 'C#']) {
      const result = parsed<{ results: { id: string }[] }>(await mcp.call('tools/call', { name: 'whim_rag_search', arguments: { query } }))
      expect(result.results[0]?.id).toBe('tech')
    }
  })

  it('validates identifiers, numeric bounds, and input sizes', async () => {
    const mcp = server()
    const badKey = await mcp.call('tools/call', { name: 'whim_context_set', arguments: { key: `bad\u001fkey`, text: 'x' } })
    const badTopK = await mcp.call('tools/call', { name: 'whim_rag_search', arguments: { query: 'x', topK: 0 } })
    const tooLarge = await mcp.call('tools/call', { name: 'whim_facts_save', arguments: { name: 'x', value: 'a'.repeat(1_000_001) } })
    expect(badKey.result?.isError).toBe(true)
    expect(badTopK.result?.isError).toBe(true)
    expect(tooLarge.result?.isError).toBe(true)
  })
})
