# whimsicality-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that gives AI agents **persistent memory** — context storage, facts, plans, RAG search, code snippets, and conversation compaction that survive across sessions and processes.

Works with any MCP-compatible agent: **Devin CLI**, **Claude Desktop**, **Cursor**, and others.

## Quick start

```bash
# Install globally
npm install -g whimsicality-mcp

# Or run without installing
npx whimsicality-mcp
```

Then add it to your agent's MCP config:

```json
{
  "mcpServers": {
    "whimsicality": {
      "command": "npx",
      "args": ["whimsicality-mcp"]
    }
  }
}
```

That's it. The server works out of the box with disk-based persistence — no native dependencies required. Data is stored in `~/.whimsicality/kernel-storage/`.

## Tools

The server exposes 14 tools, all prefixed with `whim_`:

| Tool | Purpose |
|------|---------|
| `whim_context_set` / `get` / `list` / `delete` | Persistent text context slots |
| `whim_facts_save` / `get` / `list` | Key-value facts (user prefs, project decisions) |
| `whim_plan_save` / `get` | Plan documents for long-horizon work |
| `whim_rag_index` / `search` | Document indexing and semantic search |
| `whim_snippet_save` / `search` | Reusable code snippets |
| `whim_compact` | Compress conversation history into summaries |

## How agents should use it

**At session start** — recover state from previous agents:

```
1. whim_plan_get({})              → read the current plan
2. whim_facts_list({})            → list all facts
3. whim_facts_get({name: "..."})  → read relevant facts
4. whim_context_list({})          → list all context slots
5. whim_context_get({key: "..."}) → read relevant slots
```

**As you work** — save state for the next agent:

```
whim_plan_save({plan: "updated plan with progress and next steps"})
whim_facts_save({name: "new_fact", value: "..."})
whim_context_set({key: "what_i_learned", text: "..."})
```

## Backends

The server supports four ways to find the kernel, tried in order:

### 1. Disk fallback (default, zero setup)

Works out of the box. Data persists to a JSON file at `~/.whimsicality/kernel-storage/whim-mcp-store.json`. Word-overlap search for RAG/snippets. No native dependencies.

### 2. Prebuilt kernel binary (easiest upgrade)

```bash
npm install @whimsicality/kernel-prebuilt
```

Platform-specific prebuilt binaries distributed via npm `optionalDependencies`. The server auto-discovers the binary in `node_modules`.

> **Note:** Prebuilt binaries are not yet available for all platforms. See [kernel-prebuilt](https://github.com/whimsicality/kernel-prebuilt) for status.

### 3. Point to an existing binary

```json
{
  "mcpServers": {
    "whimsicality": {
      "command": "npx",
      "args": ["whimsicality-mcp"],
      "env": {
        "WHIMSICALITY_KERNEL_BIN": "/path/to/whimsicality-kernel"
      }
    }
  }
}
```

### 4. Build from source

Clone the [Rust workspace](https://github.com/whimsicality/whimsicality-kernel) and build:

```bash
git clone https://github.com/whimsicality/whimsicality-kernel.git
cd whimsicality-kernel
cargo build --release
```

Then set `WHIMSICALITY_KERNEL_BIN` to `target/release/whimsicality-kernel`.

### What the kernel adds

The Rust kernel provides:
- **Tiered storage**: hot (RAM) → warm (mmap) → cold (zstd on disk) with auto promotion/demotion
- **Content-addressed dedup**: identical values share storage via blake3 hashing
- **Lock-free hot path**: DashMap for concurrent reads
- **Append-only session log**: bincode entries with branching/forking
- **Structured context assembly**: named variables, not flat token streams

When the kernel is available, the server **dual-writes** to both the kernel and disk. This gives you the kernel's fast in-session access plus disk persistence for cross-session reliability (the kernel's hot tier is RAM-only and lost on process exit).

## Configuration

All config is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `WHIMSICALITY_STORAGE_DIR` | `~/.whimsicality/kernel-storage` | Root directory for all stored data |
| `WHIMSICALITY_KERNEL_BIN` | (auto-discovered) | Path to the Rust kernel binary |
| `WHIMSICALITY_HOT_BUDGET_MB` | `256` | Hot tier RAM budget in MB (kernel only) |

## Development

```bash
git clone https://github.com/whimsicality/whimsicality-mcp.git
cd whimsicality-mcp
npm install
npm run build
node bin/whimsicality-mcp.js
```

## License

MIT
