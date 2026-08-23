# whimsicality-mcp

An MCP server for persistent agent memory and lexical document retrieval. Two collections — **memory** (namespaced key-value) and **docs** (searchable text) — replace the previous five flat maps. Works with MCP-compatible clients and coordinates safely across multiple long-lived server processes.

## Quick start

```bash
npm install -g whimsicality-mcp
whimsicality-mcp
```

Or configure an MCP client to run it:

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

Data is stored at `~/.whimsicality/kernel-storage/whim-mcp-store.json` by default. Writes use an inter-process lock, fsync, and atomic rename; reads observe changes made by other running processes via mtime-gated reparsing.

## Tools (9 total)

| Collection | Tools | Purpose |
|---|---|---|
| Memory | `whim_memory_set`, `whim_memory_get`, `whim_memory_list`, `whim_memory_delete`, `whim_memory_search` | Namespaced key-value store for facts, plans, context, decisions, or any text an agent should recall |
| Documents | `whim_doc_save`, `whim_doc_search`, `whim_doc_list`, `whim_doc_delete` | Searchable text documents with BM25 chunk retrieval |

**Why two collections instead of five?** The previous design (context, facts, plans, snippets, docs) had four near-identical string→string maps with tool descriptions that didn't help an agent choose between them. The collapsed design gives the agent one obvious place for key-value memory and one for searchable documents, cutting the per-request schema tax from 20 tools to 9.

Stored values include creation and update timestamps. All identifiers, item counts, result counts, and text sizes are bounded. Delete operations require their key/id argument — no defaults — to prevent accidental data loss.

### Migration from 0.3.0

Legacy `context`, `facts`, `plans`, and `snippets` data is automatically migrated into the `memory` collection on first load, namespaced by the original collection name (e.g. `facts\x1fmyfact`). Legacy `docs` entries are preserved as-is.

## Retrieval

Both `whim_doc_search` and `whim_memory_search` use **BM25** scoring (k1=1.5, b=0.75) with IDF weighting, so rare terms rank above stopwords. Documents are split into overlapping chunks and the best matching chunk is returned.

Tokenization handles:
- Short technical terms: `AI`, `Go`
- Punctuation-bearing terms: `C#`, `.NET`
- Sentence-final words: `tooling.` matches `tooling` (trailing punctuation stripped at index time, raw form also indexed)

Stored content is untrusted data. Clients should delimit retrieved memory and avoid treating it as system-level instruction.

## Optional Rust kernel

The disk store is the authoritative backend and requires no native dependency. A Rust kernel binary can mirror writes for tiered in-memory storage with content-addressed dedup, eviction to warm/cold disk tiers, and an append-only session log. **Reads always come from disk** — the kernel is a write-only mirror, eliminating cross-process staleness.

To use a kernel binary, set:

```text
WHIMSICALITY_KERNEL_BIN=/absolute/path/to/pjai-kernel
```

The kernel binary is not published as an npm package; build it from source or point `WHIMSICALITY_KERNEL_BIN` to an existing binary.

### Kernel protocol

The kernel speaks newline-delimited JSON-RPC 2.0 over stdio. The handshake is `kernel.new` with `storage_dir` and optional `hot_budget_mb`, returning a `kernel_id`. Subsequent `kernel.*` methods require `kernel_id` in params.

Supported methods: `kernel.set_text`, `kernel.get_text`, `kernel.delete`, `kernel.list`, `kernel.set_tensor`, `kernel.assemble_prompt`, `kernel.exists`, `kernel.message`, `kernel.tool_call`, `kernel.session_entries`, `kernel.session_tokens`, `kernel.hot_size`, `kernel.compact_disk`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `WHIMSICALITY_STORAGE_DIR` | `~/.whimsicality/kernel-storage` | Persistent storage directory |
| `WHIMSICALITY_KERNEL_BIN` | unset | Optional Rust kernel executable |
| `WHIMSICALITY_HOT_BUDGET_MB` | `256` | Kernel hot-tier memory budget |

## Development

```bash
git clone https://github.com/WhimsicalityLabs/Whimsicality-MCP.git
cd Whimsicality-MCP
npm install
npm test
npm run typecheck
```

The test suite builds the server and tests it through the MCP stdio protocol, including simultaneous long-lived processes, concurrency, corruption recovery, BM25 ranking, tokenizer edge cases, and KernelClient lifecycle (restart, timeout, backoff).

## License

MIT
