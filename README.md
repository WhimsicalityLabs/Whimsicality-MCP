# whimsicality-mcp

An MCP server for persistent agent memory and BM25 document retrieval. Two collections: **memory** (namespaced key-value) and **docs** (searchable full-text). Works with MCP-compatible clients and coordinates safely across multiple long-lived server processes.

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

Data is stored at `~/.whimsicality/kernel-storage/whim-mcp-store.json` by default. Writes use an inter-process lock, fsync, and atomic rename. Reads always re-parse from disk so cross-process writes are immediately visible.

## Tools (10 total)

| Tool | Description |
|---|---|
| `whim_memory_set` | Store persistent text in a namespaced key-value memory. Use for facts, plans, context, decisions. |
| `whim_memory_get` | Retrieve a stored memory value by key and namespace. Error if not found. |
| `whim_memory_list` | List all keys in a namespace. |
| `whim_memory_delete` | Delete a memory entry. Key is required — no defaults. Returns `deleted:false` if key didn't exist. |
| `whim_memory_search` | BM25 lexical search across all memory values. Returns ranked matches with scores. |
| `whim_doc_save` | Save a document for BM25 lexical chunk search. Use for long-form text, code, reference material. |
| `whim_doc_get` | Retrieve a full document by ID. Error if not found. |
| `whim_doc_search` | BM25 lexical search over saved documents. Returns match-centered chunks. |
| `whim_doc_list` | List saved document IDs. |
| `whim_doc_delete` | Delete a document. ID is required. Returns `deleted:false` if ID didn't exist. |

**Why two collections?** The previous design (v0.3.0) had four near-identical string→string maps — context, facts, plans, snippets — with tool descriptions that didn't help an agent choose between them. The collapsed design gives the agent one obvious place for key-value memory and one for searchable documents, cutting the per-request schema tax from 20 tools to 10.

Stored values include creation and update timestamps. All identifiers, item counts, result counts, and text sizes are bounded. Delete operations require their key/id argument — no defaults — to prevent accidental data loss. Not-found reads return `isError: true` consistently with all other failures.

### Migration from 0.3.0/0.4.0

Legacy `context`, `facts`, `plans`, and `snippets` data is automatically migrated into the `memory` collection on first load, namespaced by the original collection name (e.g. `facts\x1fmyfact`). Legacy `docs` entries are preserved as-is.

## Retrieval

Both `whim_doc_search` and `whim_memory_search` use **BM25** scoring (k1=1.5, b=0.75) with IDF weighting, so rare terms rank above common terms. Documents are split into overlapping chunks and the best matching chunk is returned.

Tokenization handles:
- Short technical terms: `AI`, `Go`
- Punctuation-bearing terms: `C#`, `.NET` (raw form indexed only when it contains `#` or `+`)
- Sentence-final words: `tooling.` matches `tooling` (trailing `.`/`-` stripped, no token inflation)

Stored content is untrusted data. Clients should delimit retrieved memory and avoid treating it as system-level instruction.

## What this is not

- **Not an embedding-based semantic search.** Retrieval is lexical BM25. If you need semantic similarity, use a vector store.
- **Not a database.** The store is a single JSON file. Every write rewrites the whole file synchronously. This is fine for hundreds of entries and unusable for tens of thousands. If you need scale, use SQLite or a real database.
- **No Rust kernel.** v0.3.0-v0.4.0 had an optional Rust kernel that mirrored writes but was never read from. It has been removed. The server is pure TypeScript with no native dependencies.

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

The test suite builds the server and tests it through the MCP stdio protocol, including simultaneous long-lived processes, concurrency, corruption recovery, BM25 ranking, tokenizer edge cases, cache-poisoning regression, delete-existence reporting, and legacy data migration.

## License

MIT
