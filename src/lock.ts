import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'

interface RetryOpts {
  retries: number
  factor: number
  minTimeout: number
  maxTimeout: number
  randomize: boolean
}

interface LockOptions {
  realpath?: boolean
  stale?: number
  retries?: RetryOpts
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function lock(filePath: string, opts: LockOptions = {}): Promise<() => Promise<void>> {
  const lockPath = `${filePath}.lock`
  const staleMs = opts.stale ?? 10_000
  const retryOpts: RetryOpts = opts.retries ?? { retries: 8, factor: 1.5, minTimeout: 10, maxTimeout: 250, randomize: true }
  const pid = String(process.pid)

  let lastError: unknown
  for (let attempt = 0; attempt <= retryOpts.retries; attempt++) {
    try {
      const stat = statSync(lockPath)
      if (Date.now() - stat.mtimeMs > staleMs) {
        try { unlinkSync(lockPath) } catch { }
      }
    } catch { }

    try {
      const fd = openSync(lockPath, 'wx')
      writeSync(fd, pid)
      closeSync(fd)
      return async () => {
        try {
          const content = readFileSync(lockPath, 'utf-8')
          if (content === pid) unlinkSync(lockPath)
        } catch { }
      }
    } catch (error) {
      lastError = error
      if (attempt < retryOpts.retries) {
        const base = retryOpts.minTimeout * Math.pow(retryOpts.factor, attempt)
        const timeout = Math.min(base, retryOpts.maxTimeout)
        const jitter = retryOpts.randomize ? Math.random() * timeout * 0.3 : 0
        await sleep(timeout + jitter)
      }
    }
  }
  throw new Error(`Could not acquire lock on ${filePath}: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}
