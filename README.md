# whimsicality-mcp (deprecated)

**This package is superseded by [`whimsicality-db`](https://www.npmjs.com/package/whimsicality-db).**

`whimsicality-db` is a strict superset of this server, built on SQLite + FTS5 instead of JSON files and hand-rolled BM25. It adds session tracking, event logging, todo management, and a tagged context index — all backed by SQLite's WAL mode for concurrent readers and native FTS5 for search.

## Migration

Install `whimsicality-db` and use the `db_import` tool to import your existing `whimsicality-mcp` data:

```json
{
  "mcpServers": {
    "whimsicality-db": {
      "command": "npx",
      "args": ["whimsicality-db"]
    }
  }
}
```

Then call `db_import` with the path to your old storage directory:

```
db_import({ source_dir: "~/.whimsicality/mcp-storage" })
```

Your memory entries, documents, and cache chunks will be imported into the SQLite database. After verifying, you can remove the old storage directory.

## Why the switch?

This server used a JSON file for memory and docs, with a hand-rolled lockfile protocol, atomic-rename discipline, byte-bounded LRU, garbage collector, and BM25 implementation. SQLite gives you WAL, transactions, page cache, no orphans, and a battle-tested BM25 for free. The result is faster, more reliable, and scales to millions of entries instead of thousands.

## License

MIT
