import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const FAKE_KERNEL = `
let buf = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let req
    try { req = JSON.parse(line) } catch { continue }
    if (req.method === 'kernel.new') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { kernel_id: 'fake-k0' } }) + '\\n')
    } else if (req.method === 'kernel.exit') {
      process.exit(1)
    } else if (req.method === 'kernel.hang') {
      // never respond — triggers timeout
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } }) + '\\n')
    }
  }
})
`

describe('KernelClient', () => {
  let dir: string
  let originalKernelBin: string | undefined
  let fakeKernelScript: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'whim-kernel-test-'))
    originalKernelBin = process.env.WHIMSICALITY_KERNEL_BIN
    fakeKernelScript = join(dir, 'fake-kernel.js')
    writeFileSync(fakeKernelScript, FAKE_KERNEL, 'utf-8')
    process.env.WHIMSICALITY_KERNEL_BIN = process.execPath
  })

  afterEach(() => {
    if (originalKernelBin === undefined) delete process.env.WHIMSICALITY_KERNEL_BIN
    else process.env.WHIMSICALITY_KERNEL_BIN = originalKernelBin
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts, calls, and stops cleanly', async () => {
    const { KernelClient } = await import('../src/kernel-client.js')
    const client = new KernelClient({ storageDir: dir, autoRestart: false, requestTimeoutMs: 2000, kernelArgs: [fakeKernelScript] })
    await client.start()
    expect(client.kernelId).toBe('fake-k0')
    const result = await client.call('kernel.ping', {}) as { ok: boolean }
    expect(result.ok).toBe(true)
    client.stop()
  })

  it('times out when the kernel does not respond', async () => {
    const { KernelClient } = await import('../src/kernel-client.js')
    const client = new KernelClient({ storageDir: dir, autoRestart: false, requestTimeoutMs: 200, kernelArgs: [fakeKernelScript] })
    await client.start()
    await expect(client.call('kernel.hang', {})).rejects.toThrow(/timed out/)
    client.stop()
  })

  it('restarts after unexpected exit and resets attempts after stable window', async () => {
    const { KernelClient } = await import('../src/kernel-client.js')
    const client = new KernelClient({ storageDir: dir, autoRestart: true, maxRestarts: 3, requestTimeoutMs: 2000, stableRunMs: 150, kernelArgs: [fakeKernelScript] })
    await client.start()
    await expect(client.call('kernel.exit', {})).rejects.toThrow(/exited/)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const result = await client.call('kernel.ping', {}) as { ok: boolean }
    expect(result.ok).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 250))
    client.stop()
  })

  it('gives up after max restarts', async () => {
    const { KernelClient } = await import('../src/kernel-client.js')
    const client = new KernelClient({ storageDir: dir, autoRestart: true, maxRestarts: 1, requestTimeoutMs: 1000, stableRunMs: 60_000, kernelArgs: [fakeKernelScript] })
    await client.start()
    await expect(client.call('kernel.exit', {})).rejects.toThrow(/exited/)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await expect(client.call('kernel.exit', {})).rejects.toThrow(/exited|not started/)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    await expect(client.call('kernel.ping', {})).rejects.toThrow()
    client.stop()
  })
})
