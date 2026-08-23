import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const KERNEL_BIN_ENV = 'WHIMSICALITY_KERNEL_BIN'

function resolveKernelBin(): string {
  const envPath = process.env[KERNEL_BIN_ENV]
  if (envPath && existsSync(envPath)) return envPath
  throw new Error(`kernel binary not found; set ${KERNEL_BIN_ENV} to an existing binary path`)
}

export function defaultStorageDir(): string {
  return join(homedir(), '.whimsicality', 'kernel-storage')
}

interface RpcError {
  code: number
  message: string
}

interface RpcResponse {
  id?: number
  result?: unknown
  error?: RpcError
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface KernelClientOptions {
  storageDir: string
  hotBudgetMb?: number
  autoRestart?: boolean
  maxRestarts?: number
  requestTimeoutMs?: number
  stableRunMs?: number
  kernelArgs?: string[]
}

export class KernelClient {
  private readonly storageDir: string
  private readonly hotBudgetMb: number | undefined
  private readonly autoRestart: boolean
  private readonly maxRestarts: number
  private readonly requestTimeoutMs: number
  private readonly stableRunMs: number
  private readonly kernelArgs: string[]
  private child: ChildProcess | null = null
  private kernelIdValue: string | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private stdoutBuffer = ''
  private stopped = true
  private restartAttempts = 0
  private restartTimer: NodeJS.Timeout | null = null
  private stableTimer: NodeJS.Timeout | null = null
  private startPromise: Promise<void> | null = null

  constructor(options: KernelClientOptions) {
    this.storageDir = options.storageDir
    this.hotBudgetMb = options.hotBudgetMb
    this.autoRestart = options.autoRestart ?? true
    this.maxRestarts = options.maxRestarts ?? 5
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    this.stableRunMs = options.stableRunMs ?? 60_000
    this.kernelArgs = options.kernelArgs ?? []
  }

  get kernelId(): string | null {
    return this.kernelIdValue
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    this.stopped = false
    this.startPromise = this.startProcess().finally(() => { this.startPromise = null })
    return this.startPromise
  }

  private async startProcess(): Promise<void> {
    const binPath = resolveKernelBin()
    const child = spawn(binPath, this.kernelArgs, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
    this.child = child
    this.stdoutBuffer = ''
    child.stdout!.setEncoding('utf-8')
    child.stdout!.on('data', (chunk: string) => this.onStdoutData(chunk))
    child.once('exit', (code, signal) => this.onExit(child, code, signal))
    child.once('error', (error) => this.onError(child, error))
    try {
      const params: Record<string, unknown> = { storage_dir: this.storageDir }
      if (this.hotBudgetMb !== undefined) params.hot_budget_mb = this.hotBudgetMb
      const result = await this.call('kernel.new', params) as { kernel_id?: unknown }
      if (typeof result.kernel_id !== 'string' || result.kernel_id.length === 0) throw new Error('kernel.new returned no kernel_id')
      this.kernelIdValue = result.kernel_id
      this.armStableReset()
    } catch (error) {
      if (this.child === child) {
        this.child = null
        child.kill()
      }
      throw error
    }
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    const child = this.child
    this.child = null
    this.kernelIdValue = null
    if (child) child.kill()
    this.rejectPending(new Error('kernel stopped'))
  }

  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child
    if (!child || child.killed || !child.stdin?.writable) return Promise.reject(new Error('kernel not started'))
    const id = this.nextId++
    const fullParams = method.startsWith('kernel.') && this.kernelIdValue ? { kernel_id: this.kernelIdValue, ...params } : params
    const request = `${JSON.stringify({ jsonrpc: '2.0', id, method, params: fullParams })}\n`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`kernel RPC timed out after ${this.requestTimeoutMs}ms: ${method}`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin!.write(request, (error) => {
        if (!error) return
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        clearTimeout(pending.timer)
        pending.reject(new Error(`failed to write to kernel stdin: ${error.message}`))
      })
    })
  }

  private onStdoutData(chunk: string): void {
    this.stdoutBuffer += chunk
    let newline: number
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line) this.onLine(line)
    }
  }

  private onLine(line: string): void {
    let response: RpcResponse
    try { response = JSON.parse(line) as RpcResponse } catch { process.stderr.write('whimsicality-mcp: kernel emitted invalid JSON\n'); return }
    if (response.id === undefined) return
    const request = this.pending.get(response.id)
    if (!request) return
    this.pending.delete(response.id)
    clearTimeout(request.timer)
    if (response.error) request.reject(new Error(`${response.error.code}: ${response.error.message}`))
    else request.resolve(response.result)
  }

  private onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.child !== child) return
    this.child = null
    this.kernelIdValue = null
    this.clearStableTimer()
    this.rejectPending(new Error(`kernel exited (code=${code}, signal=${signal})`))
    this.scheduleRestart()
  }

  private onError(child: ChildProcess, error: Error): void {
    if (this.child !== child) return
    this.child = null
    this.kernelIdValue = null
    this.clearStableTimer()
    this.rejectPending(new Error(`kernel process error: ${error.message}`))
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.stopped || !this.autoRestart || this.restartTimer || this.restartAttempts >= this.maxRestarts) {
      if (!this.stopped && this.autoRestart && this.restartAttempts >= this.maxRestarts) process.stderr.write(`whimsicality-mcp: kernel restart gave up after ${this.maxRestarts} attempts\n`)
      return
    }
    const delayMs = Math.min(1000 * 2 ** this.restartAttempts, 30_000)
    this.restartAttempts++
    process.stderr.write(`whimsicality-mcp: kernel restart attempt ${this.restartAttempts}/${this.maxRestarts} in ${delayMs}ms\n`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopped) return
      this.start().catch((error) => {
        process.stderr.write(`whimsicality-mcp: kernel restart failed: ${error instanceof Error ? error.message : String(error)}\n`)
        this.scheduleRestart()
      })
    }, delayMs)
  }

  private armStableReset(): void {
    this.clearStableTimer()
    this.stableTimer = setTimeout(() => { this.stableTimer = null; this.restartAttempts = 0 }, this.stableRunMs)
  }

  private clearStableTimer(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = null
  }

  private clearTimers(): void {
    this.clearStableTimer()
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private rejectPending(error: Error): void {
    for (const [id, request] of this.pending) {
      this.pending.delete(id)
      clearTimeout(request.timer)
      request.reject(error)
    }
  }
}
