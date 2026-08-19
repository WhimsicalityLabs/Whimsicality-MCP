/**
 * TypeScript client for the Whimsicality Rust kernel binary over JSON-RPC.
 * Spawns the kernel subprocess and communicates over stdin/stdout using
 * newline-delimited JSON-RPC 2.0.
 *
 * @module whimsicality-mcp/kernel-client
 */

import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

/** Environment variable name for overriding the kernel binary path. */
const KERNEL_BIN_ENV = 'WHIMSICALITY_KERNEL_BIN'

/** Platform-specific executable extension. */
const EXE = process.platform === 'win32' ? '.exe' : ''

/** Directory containing this module. */
const here = dirname(fileURLToPath(import.meta.url))

/**
 * Resolve the path to the Whimsicality kernel binary.
 *
 * Resolution order:
 * 1. `WHIMSICALITY_KERNEL_BIN` env var (explicit override)
 * 2. Prebuilt binary in `node_modules/@whimsicality/kernel-prebuilt` (npm optionalDependency)
 * 3. Rust workspace `target/debug/` (development)
 * 4. Rust workspace `target/release/` (development)
 *
 * @returns the absolute path to the kernel binary.
 * @throws if no binary is found at any candidate location.
 */
function resolveKernelBin(): string {
  const envPath = process.env[KERNEL_BIN_ENV]
  if (envPath && existsSync(envPath)) return envPath

  // Prebuilt binary from npm optionalDependency.
  const prebuiltNames = [`whimsicality-kernel${EXE}`, `pjai-kernel${EXE}`]
  for (const name of prebuiltNames) {
    const prebuiltPath = join(here, '..', 'node_modules', '@whimsicality', 'kernel-prebuilt', name)
    if (existsSync(prebuiltPath)) return prebuiltPath
  }

  // Rust workspace builds (development).
  for (const name of prebuiltNames) {
    const debugPath = join(here, '..', '..', '..', '..', 'rust', 'target', 'debug', name)
    if (existsSync(debugPath)) return debugPath

    const releasePath = join(here, '..', '..', '..', '..', 'rust', 'target', 'release', name)
    if (existsSync(releasePath)) return releasePath
  }

  throw new Error(
    `kernel binary not found. Set ${KERNEL_BIN_ENV} to the binary path, ` +
    `install @whimsicality/kernel-prebuilt, or build the Rust workspace. ` +
    `See README for setup instructions.`,
  )
}

/** Default storage directory: ~/.whimsicality/kernel-storage */
export function defaultStorageDir(): string {
  return join(homedir(), '.whimsicality', 'kernel-storage')
}

/** JSON-RPC 2.0 error object. */
interface RpcError {
  code: number
  message: string
  data?: unknown
}

/** JSON-RPC 2.0 response envelope. */
interface RpcResponse {
  jsonrpc: string
  id?: number
  result?: unknown
  error?: RpcError
}

/** A pending JSON-RPC request awaiting its response. */
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** Constructor options for {@link KernelClient}. */
export interface KernelClientOptions {
  /** Root directory for the kernel's warm/cold storage tiers. */
  storageDir: string
  /** Hot tier RAM budget in MB. */
  hotBudgetMb?: number
  /** Auto-restart the kernel subprocess on unexpected exit (default true). */
  autoRestart?: boolean
}

/**
 * Client for the Whimsicality Rust kernel binary. Manages the kernel subprocess
 * lifecycle and provides typed JSON-RPC 2.0 request/response correlation over
 * stdin/stdout.
 */
export class KernelClient {
  private readonly storageDir: string
  private readonly hotBudgetMb: number | undefined
  private readonly autoRestart: boolean
  private child: ChildProcess | null = null
  private kernelIdValue: string | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private stdoutBuffer = ''
  private stopped = false

  constructor(options: KernelClientOptions) {
    this.storageDir = options.storageDir
    this.hotBudgetMb = options.hotBudgetMb
    this.autoRestart = options.autoRestart ?? true
  }

  /** The kernel instance id, or null if not started. */
  get kernelId(): string | null {
    return this.kernelIdValue
  }

  /**
   * Start the kernel binary subprocess and initialize a kernel instance.
   * @throws if the binary cannot be found or the kernel fails to initialize.
   */
  async start(): Promise<void> {
    this.stopped = false
    const binPath = resolveKernelBin()
    this.child = spawn(binPath, [], {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    })

    this.child.stdout!.setEncoding('utf-8')
    this.child.stdout!.on('data', (chunk: string) => this.onStdoutData(chunk))
    this.child.on('exit', (code, signal) => this.onExit(code, signal))
    this.child.on('error', (err) => this.onError(err))

    const params: Record<string, unknown> = { storage_dir: this.storageDir }
    if (this.hotBudgetMb !== undefined) {
      params.hot_budget_mb = this.hotBudgetMb
    }
    const result = await this.call('kernel.new', params)
    this.kernelIdValue = (result as { kernel_id: string }).kernel_id
  }

  /** Stop the kernel binary and reject all pending requests. */
  stop(): void {
    this.stopped = true
    if (this.child) {
      this.child.kill()
      this.child = null
    }
    this.kernelIdValue = null
    this.rejectPending(new Error('kernel stopped'))
  }

  /**
   * Send a JSON-RPC call to the kernel binary and await the response.
   * Automatically injects `kernel_id` into params for kernel-scoped methods.
   */
  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.child || this.child.killed) {
      return Promise.reject(new Error('kernel not started'))
    }
    const id = this.nextId++
    const fullParams = method.startsWith('kernel.') && this.kernelIdValue
      ? { kernel_id: this.kernelIdValue, ...params }
      : params
    const request = { jsonrpc: '2.0' as const, id, method, params: fullParams }
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.child!.stdin!.write(JSON.stringify(request) + '\n')
      } catch (err) {
        this.pending.delete(id)
        reject(new Error(`failed to write to kernel stdin: ${(err as Error).message}`))
      }
    })
  }

  private onStdoutData(chunk: string): void {
    this.stdoutBuffer += chunk
    let newlineIndex: number
    while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      if (line) this.onLine(line)
    }
  }

  private onLine(line: string): void {
    let response: RpcResponse
    try {
      response = JSON.parse(line) as RpcResponse
    } catch {
      return
    }
    if (response.id === undefined) return
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    if (response.error) {
      pending.reject(new Error(`${response.error.code}: ${response.error.message}`))
    } else {
      pending.resolve(response.result)
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.rejectPending(new Error(`kernel exited (code=${code}, signal=${signal})`))
    this.child = null
    this.kernelIdValue = null
    if (!this.stopped && this.autoRestart) {
      this.start().catch(() => {})
    }
  }

  private onError(err: Error): void {
    this.rejectPending(new Error(`kernel process error: ${err.message}`))
    this.child = null
    this.kernelIdValue = null
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(error)
    }
  }
}
