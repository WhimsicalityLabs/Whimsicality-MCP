# whimsicality-mcp

An MCP server for persistent agent memory, BM25 document retrieval, and **infinite context caching** — a paged virtual memory system for LLM context. Three collections: **memory** (namespaced key-value), **docs** (searchable full-text), and **cache** (compressed, paged content with a dense index). Works with MCP-compatible clients and coordinates safely across multiple long-lived server processes.

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

Data is stored at `~/.whimsicality/kernel-storage/` by default. Writes use inter-process locks, fsync, and atomic rename. Reads always re-parse from disk so cross-process writes are immediately visible.

## The differentiator: Infinite Context Cache

The cache is **virtual memory for LLM context**. It solves the problem of having more context than fits in a model's window.

### How it works

```
┌──────────────────────────────────────────────────────────┐
│ LLM Context Window (limited)                             │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Dense Index Table (~1-2 tokens per entry)          │  │
│  │ | ID  | Topic     | Summary          |             │  │
│  │ | a1  | auth      | JWT RS256, 7d    |             │  │
│  │ | a2  | db        | Postgres 16      |             │  │
│  │ | ... | ...       | ...              |             │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Model calls whim_cache_read("a1") when it needs detail  │
│  → full decompressed content injected into context       │
│                                                          │
└──────────────────────────────────────────────────────────┘
           │
           │ whim_cache_read(id)
           ▼
┌──────────────────────────────────────────────────────────┐
│ Disk (unlimited)                                         │
│                                                          │
│  cache-index.json  ← compact metadata                    │
│  cache-chunks/     ← brotli-compressed content (5-15x)   │
│    a1.br  a2.br  b3.br  ...                              │
│                                                          │
│  LRU cache (64 entries) keeps recently-read chunks hot   │
└──────────────────────────────────────────────────────────┘
```

**The key insight:** you pay tokens only for what you actually use, not for everything that *might* be relevant.

1. **Store** content with `whim_cache_store` — content is brotli-compressed on disk (5-15x ratio). You get a chunk ID back.
2. **Inject the index** with `whim_cache_index` — returns a compact summary table (~1-2 tokens per entry). 200 entries costs ~300-400 tokens.
3. **Read on demand** with `whim_cache_read` — decompresses a single chunk. The model only loads what it needs.
4. **Search** with `whim_cache_search` — BM25 over the index (topic, summary, tags) to find relevant chunk IDs.

### Why this beats grepping files

| Problem | Grepping files | Context cache |
|---------|---------------|---------------|
| Token cost | Full file content loaded | Only summaries + requested chunks |
| Large files | O(n) scan, hits context limits | Constant-time index lookup |
| Irrelevant content | All matching lines included | 1-line summary, detail on demand |
| Scalability | Degrades with file count | 10K chunks = same index scan cost |
| Compression | None (plaintext) | 5-15x brotli on disk |
| Repeat access | Re-reads every time | LRU cache for recently read chunks |

## Tools (17 total)

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

### Cache — infinite context (compressed, paged)

| Tool | Description |
|---|---|
| `whim_cache_store` | Store content in the compressed cache. Returns ID + compression stats. Auto-generates topic/summary if omitted. |
| `whim_cache_index` | Get the compact summary table. Designed for context injection (~1-2 tokens/entry). Optional topic filter + limit. |
| `whim_cache_read` | Read and decompress a chunk by ID. LRU-cached for repeat access. |
| `whim_cache_search` | BM25 search over cache index (topic, summary, tags). |
| `whim_cache_list` | List all cached chunk IDs. |
| `whim_cache_delete` | Delete a cached chunk. ID required. Returns `deleted:false` if absent. |
| `whim_cache_stats` | Entry count, total bytes, compression ratio. |

**When to use which collection:**
- **Memory**: small key-value pairs you want to recall by exact key (facts, decisions, plans)
- **Docs**: documents you want to search by content (returns matching chunks)
- **Cache**: large content you want to page in on demand (returns full content, compressed on disk)

### Migration from 0.3.0/0.4.0

Legacy `context`, `facts`, `plans`, and `snippets` data is automatically migrated into the `memory` collection on first load, namespaced by the original collection name. Legacy `docs` entries are preserved as-is.

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
| `WHIMSICALITY_STORAGE_DIR` | `~/.whimsicality/kernel-storage` | Persistent storage directory |

## Development

```bash
git clone https://github.com/WhimsicalityLabs/Whimsicality-MCP.git
cd Whimsicality-MCP
npm install
npm test
npm run typecheck
```

The test suite (26 tests) covers cross-process writes, concurrency, corruption recovery, BM25 ranking, tokenizer edge cases, cache-poisoning regression, delete-existence reporting, legacy migration, cache compression, cache cross-process visibility, and cache index/search.

## License

MIT
