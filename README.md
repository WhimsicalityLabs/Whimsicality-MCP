# whimsicality-mcp

[![M8ven Score](https://m8ven.ai/badge/mcp/whimsicalitylabs-whimsicality-mcp-1tiedz?v=28b3ac8da93591664fe853fbe6e715b3)](https://m8ven.ai/mcp/whimsicalitylabs-whimsicality-mcp-1tiedz)

An MCP server for persistent agent memory, BM25 document retrieval, and **paged context caching** — lazy-loading for LLM context. Three collections: **memory** (namespaced key-value), **docs** (searchable full-text), and **cache** (paged, compressed content with a dense index). Works with MCP-compatible clients and coordinates safely across multiple long-lived server processes.

## Quick start

Add to your MCP client config:

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

That's it — `npx` fetches and runs the latest published version automatically. No clone, no build, no path to manage.

Data is stored at `~/.whimsicality/storage/` by default. Writes use inter-process locks, fsync, and atomic rename. Reads always re-parse from disk so cross-process writes are immediately visible.

### Building from source

If you want to run from source (development, unreleased changes, air-gapped environments):

```bash
git clone https://github.com/WhimsicalityLabs/Whimsicality-MCP.git
cd Whimsicality-MCP
npm install
npm run build
```

Then use `node` with the absolute path to `bin/whimsicality-mcp.js`:

```json
{
  "mcpServers": {
    "whimsicality": {
      "command": "node",
      "args": ["/absolute/path/to/Whimsicality-MCP/bin/whimsicality-mcp.js"]
    }
  }
}
```

### 0.1.x → 0.7.x breaking changes

If you were running the registry's `0.1.1`, upgrading to `0.7.1` is a significant jump:

- **Tool names changed**: all tools are now prefixed `whim_` (was `whimsicality_`). Old configs referencing old tool names will not work.
- **Storage layout changed**: `~/.whimsicality/kernel-storage/` → `~/.whimsicality/storage/`. The server auto-migrates on first run.
- **Collection model changed**: five collections (context, facts, plans, snippets, docs) collapsed into `memory` (namespaced key-value) and `docs` (full-text search). Legacy data is auto-migrated into `memory` with namespace prefixes.
- **Rust kernel removed**: the optional native kernel from 0.3.0-0.4.0 is gone. The server is pure TypeScript.
- **New: paged context cache**: 8 new tools for compressed, paged content retrieval (`whim_cache_*`).

## The differentiator: Paged Context Cache

The cache is **lazy-loading for LLM context**. It solves the problem of having more context than fits in a model's window.

### How it works

```
┌──────────────────────────────────────────────────────────┐
│ LLM Context Window (limited)                             │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Dense Index Table                                  │  │
│  │ | ID  | Topic     | Summary          |             │  │
│  │ | a1  | auth      | JWT RS256, 7d    |             │  │
│  │ | a2  | db        | Postgres 16      |             │  │
│  │ | ... | ...       | ...              |             │  │
│  └────────────────────────────────────────────────────┘  │
│  Model scans the table, then calls whim_cache_read       │
│  with an ID + offset + length to load only what it needs │
│                                                          │
└──────────────────────────────────────────────────────────┘
           │
           │ whim_cache_read(id, offset, length)
           ▼
┌──────────────────────────────────────────────────────────┐
│ Disk (unlimited)                                         │
│                                                          │
│  cache-index.json  ← compact metadata                    │
│  cache-chunks/     ← brotli-compressed content           │
│    <sha256>.br     ← filenames are hashed IDs            │
│                                                          │
│  LRU cache (64 entries) keeps recently read chunks hot   │
└──────────────────────────────────────────────────────────┘
```

**The key insight:** you pay tokens only for what you actually use, not for everything that *might* be relevant. The token savings come from **lazy paging** — the model loads a summary table, then reads only the chunks it needs, at the size it needs.

### Token cost

The index table costs roughly **1 token per 4 characters** of rendered text. A realistic row with a 20-char ID, 40-char topic, and 80-char summary is ~140 characters ≈ **~35 tokens per entry**. 100 entries ≈ ~3,500 tokens. The `whim_cache_index` tool prints the actual estimate at the bottom of the table so you know the real cost before injecting.

### Paging

`whim_cache_read` supports `offset` and `length` parameters. Default length is 8,000 characters (~2,000 tokens). The response includes `totalLength` and `hasMore` so the model can page through large content without blowing the context window:

```
whim_cache_read({ id: "design-doc", offset: 0, length: 8000 })
→ { content: "...", offset: 0, length: 8000, totalLength: 45000, hasMore: true }

whim_cache_read({ id: "design-doc", offset: 8000, length: 8000 })
→ { content: "...", offset: 8000, length: 8000, totalLength: 45000, hasMore: true }
```

### What brotli does (and doesn't do)

Brotli compression saves **disk space** (typically 3-5x on prose and code). It does not save tokens — `cache_read` decompresses and returns plaintext into the context window. The token savings come entirely from the paging mechanism. Compression is an implementation detail on the cheapest resource in the system.

### Why this beats grepping files

| Problem | Grepping files | Context cache |
|---------|---------------|---------------|
| Token cost | Full file content loaded | Only summaries + requested pages |
| Large files | O(n) scan, hits context limits | Paged reads with offset+length |
| Irrelevant content | All matching lines included | 1-line summary, detail on demand |
| Scalability | Degrades with file count | 10K chunks = same index scan cost |
| Repeat access | Re-reads every time | LRU cache for recently read chunks |
| Security | filenames = user input | filenames = SHA-256 hashes of IDs |

## Tools (18 total)

### Memory — namespaced key-value store

| Tool | Description |
|---|---|
| `whim_memory_set` | Store persistent text. Use for facts, plans, context, decisions. |
| `whim_memory_get` | Retrieve by key and namespace. Error if not found. |
| `whim_memory_list` | List all keys in a namespace. |
| `whim_memory_delete` | Delete an entry. Key required. Returns `deleted:false` if absent. |
| `whim_memory_search` | BM25 lexical search across all memory values. |

### Documents — searchable full-text

| Tool | Description |
|---|---|
| `whim_doc_save` | Save a document for BM25 chunk search. |
| `whim_doc_get` | Retrieve a full document by ID. Error if not found. |
| `whim_doc_search` | BM25 search over documents. Returns match-centered chunks. |
| `whim_doc_list` | List saved document IDs. |
| `whim_doc_delete` | Delete a document. ID required. Returns `deleted:false` if absent. |

### Cache — paged context (compressed, lazy-loaded)

| Tool | Description |
|---|---|
| `whim_cache_store` | Store content. Brotli-compressed on disk. Auto-generates topic/summary if omitted. Returns compression stats. |
| `whim_cache_index` | Compact summary table for context injection. Optional topic filter + limit. Prints token estimate. |
| `whim_cache_read` | Read a chunk by ID with paging (offset + length). LRU-cached. Returns totalLength + hasMore. |
| `whim_cache_search` | BM25 search over cache index (topic, summary, tags). |
| `whim_cache_list` | List all cached chunk IDs. |
| `whim_cache_delete` | Delete a cached chunk. ID required. Returns `deleted:false` if absent. |
| `whim_cache_stats` | Entry count, total bytes, compression ratio. |
| `whim_cache_gc` | Remove orphaned chunk files with no index entry. Returns count removed + bytes freed. |

**When to use which collection:**
- **Memory**: small key-value pairs you want to recall by exact key (facts, decisions, plans)
- **Docs**: documents you want to search by content (returns matching chunks)
- **Cache**: large content you want to page in on demand (returns full content, paged, compressed on disk)

### Migration from 0.3.0/0.4.0

Legacy `context`, `facts`, `plans`, and `snippets` data is automatically migrated into the `memory` collection on first load, namespaced by the original collection name. Legacy `docs` entries are preserved as-is.

### Migration from 0.6.0

The storage directory was renamed from `~/.whimsicality/kernel-storage` to `~/.whimsicality/storage` in v0.7.0. On first run, if the new directory does not exist and the old one does, it is automatically renamed. No data is lost.

## Retrieval

All search tools use **BM25** scoring (k1=1.5, b=0.75) with IDF weighting, so rare terms rank above common terms.

Tokenization handles:
- Short technical terms: `AI`, `Go`
- Punctuation-bearing terms: `C#`, `.NET`
- Sentence-final words: `tooling.` matches `tooling`

Stored content is untrusted data. Clients should delimit retrieved memory and avoid treating it as system-level instruction.

## What this is not

- **Not an embedding-based semantic search.** Retrieval is lexical BM25. If you need semantic similarity, use a vector store.
- **Not a database.** Memory and docs use a single JSON file. Every write rewrites the whole file synchronously. Fine for hundreds of entries, unusable for tens of thousands. The cache uses separate compressed files per chunk and is more scalable.
- **No Rust kernel.** v0.3.0-v0.4.0 had an optional Rust kernel that was never read from. It has been removed. The server is pure TypeScript with no native dependencies.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `WHIMSICALITY_STORAGE_DIR` | `~/.whimsicality/storage` | Persistent storage directory |

## Development

```bash
git clone https://github.com/WhimsicalityLabs/Whimsicality-MCP.git
cd Whimsicality-MCP
npm install
npm test
npm run typecheck
```

The test suite (34 tests) covers cross-process writes, concurrency, corruption recovery, BM25 ranking, tokenizer edge cases, cache-poisoning regression, delete-existence reporting, legacy migration, cache compression, cache paging, cache cross-process visibility, LRU staleness after overwrite, path traversal safety, token estimates, orphaned chunk GC, and tag validation.

## License

MIT
