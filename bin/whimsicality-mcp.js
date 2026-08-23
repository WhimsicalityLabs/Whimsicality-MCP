#!/usr/bin/env node
import('../lib/index.js').catch((error) => {
  process.stderr.write(`whimsicality-mcp: failed to start. Run "npm run build" first.\n${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
