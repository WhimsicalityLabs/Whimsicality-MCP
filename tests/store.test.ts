import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Import the internal DiskStore by reaching into the compiled source.
// The DiskStore class is not exported, so we test it through a thin wrapper.
import { spawn } from 'node:child_process'

/** Spawn the MCP server, send a JSON-RPC request, and collect the response. */
async function mcpCall(storageDir: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['lib/index.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WHIMSICALITY_STORAGE_DIR: storageDir, WHIMSICALITY_KERNEL_BIN: '/nonexistent' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout!.setEncoding('utf-8')
    child.stderr!.setEncoding('utf-8')
    child.stdout!.on('data', (d: string) => { stdout += d })
    child.stderr!.on('data', (d: string) => { stderr += d })

    const req = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n'
    child.stdin!.write(req)

    setTimeout(() => {
      child.kill()
      try {
        const lines = stdout.trim().split('\n')
        for (const line of lines) {
          const parsed = JSON.parse(line)
          if (parsed.id === 1) {
            resolve(parsed.result ?? parsed.error)
            return
          }
        }
        reject(new Error(`no response. stderr: ${stderr}`))
      } catch {
        reject(new Error(`could not parse response. stdout: ${stdout}, stderr: ${stderr}`))
      }
    }, 500)
  })
}

describe('DiskStore persistence', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'whim-test-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists facts across processes', async () => {
    await mcpCall(dir, 'tools/call', { name: 'whim_facts_save', arguments: { name: 'user', value: 'alice' } })
    const result = await mcpCall(dir, 'tools/call', { name: 'whim_facts_get', arguments: { name: 'user' } })
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining('alice') }] })
  })

  it('persists context across processes', async () => {
    await mcpCall(dir, 'tools/call', { name: 'whim_context_set', arguments: { key: 'state', text: 'hello world' } })
    const result = await mcpCall(dir, 'tools/call', { name: 'whim_context_get', arguments: { key: 'state' } })
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining('hello world') }] })
  })

  it('persists plans across processes', async () => {
    await mcpCall(dir, 'tools/call', { name: 'whim_plan_save', arguments: { plan: 'step 1\nstep 2' } })
    const result = await mcpCall(dir, 'tools/call', { name: 'whim_plan_get', arguments: {} })
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining('step 1') }] })
  })

  it('survives corrupt store file without losing data silently', async () => {
    // Write valid data first.
    await mcpCall(dir, 'tools/call', { name: 'whim_facts_save', arguments: { name: 'key1', value: 'val1' } })
    // Corrupt the store file.
    const storePath = join(dir, 'whim-mcp-store.json')
    writeFileSync(storePath, '{ "broken json', 'utf-8')
    // Next call should start fresh and not crash.
    const result = await mcpCall(dir, 'tools/call', { name: 'whim_facts_get', arguments: { name: 'key1' } })
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining('not found') }] })
    // The corrupt file should have been renamed.
    const files = require('node:fs').readdirSync(dir)
    expect(files.some((f: string) => f.startsWith('whim-mcp-store.json.corrupt-'))).toBe(true)
  })

  it('rejects missing required arguments', async () => {
    const result = await mcpCall(dir, 'tools/call', { name: 'whim_facts_save', arguments: { name: 'test' } })
    expect(result).toMatchObject({ content: [{ text: expect.stringContaining('Missing or invalid') }] })
  })

  it('word-boundary matching does not match substrings', async () => {
    await mcpCall(dir, 'tools/call', { name: 'whim_rag_index', arguments: { id: 'doc1', text: 'The category system works well' } })
    // "cat" should NOT match "category" with word-boundary matching.
    const result = await mcpCall(dir, 'tools/call', { name: 'whim_rag_search', arguments: { query: 'cat' } })
    const parsed = JSON.parse(JSON.stringify(result)) as { content: [{ text: string }] }
    const inner = JSON.parse(parsed.content[0].text) as { results: unknown[] }
    // "cat" should NOT match "category" with word-boundary matching.
    expect(inner.results).toHaveLength(0)
  })

  it('word-boundary matching matches exact words', async () => {
    await mcpCall(dir, 'tools/call', { name: 'whim_rag_index', arguments: { id: 'doc1', text: 'The cat sat on the mat' } })
    const result = await mcpCall(dir, 'tools/call', { name: 'whim_rag_search', arguments: { query: 'cat' } })
    const text = JSON.stringify(result)
    expect(text).toContain('cat sat on the mat')
  })

  it('compact truncates middle messages honestly', async () => {
    const messages = ['first message', 'middle content that is long', 'last message']
    const result = await mcpCall(dir, 'tools/call', { name: 'whim_compact', arguments: { messages, maxTokens: 1 } })
    const text = JSON.stringify(result)
    expect(text).toContain('truncated')
    expect(text).toContain('first message')
    expect(text).toContain('last message')
  })
})
