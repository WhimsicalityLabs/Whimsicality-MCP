# whimsicality-mcp

An MCP server for persistent agent memory, named facts and plans, reusable snippets, and lexical document retrieval. It works with MCP-compatible clients and coordinates safely across multiple long-lived server processes.

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

Data is stored at `~/.whimsicality/kernel-storage/whim-mcp-store.json` by default. Writes use an inter-process lock and atomic rename; reads observe changes made by other running processes.

## Tools

| Collection | Tools |
|---|---|
| Namespaced context | `whim_context_set`, `whim_context_get`, `whim_context_list`, `whim_context_delete` |
| Facts | `whim_facts_save`, `whim_facts_get`, `whim_facts_list`, `whim_facts_delete` |
| Plans | `whim_plan_save`, `whim_plan_get`, `whim_plan_list`, `whim_plan_delete` |
| Documents | `whim_rag_index`, `whim_rag_search`, `whim_rag_list`, `whim_rag_delete` |
| Snippets | `whim_snippet_save`, `whim_snippet_search`, `whim_snippet_list`, `whim_snippet_delete` |

Facts are suitable for stable named values, plans for long-horizon task state, context slots for other namespaced text, documents for retrievable reference material, and snippets for reusable code.

Stored values include creation and update timestamps. All collections support listing and deletion. Identifiers, item counts, result counts, and text sizes are bounded to prevent accidental unbounded growth.

## Retrieval

Document retrieval is lexical, not embedding-based semantic search. Documents are split into overlapping chunks, scored by exact normalized term overlap, and returned with the best matching chunk. Technical terms such as `AI`, `Go`, and `C#` are supported.

Stored content is untrusted data. Clients should delimit retrieved memory and avoid treating it as system-level instruction.

## Optional Rust kernel

The disk store is the authoritative backend and requires no native dependency. A Rust kernel binary can be used alongside the disk store for tiered in-memory storage with content-addressed dedup, eviction to warm/cold disk tiers, and an append-only session log.

To use a kernel binary, set:

```text
WHIMSICALITY_KERNEL_BIN=/absolute/path/to/pjai-kernel
```

The server mirrors supported writes to the kernel and falls back to disk when kernel calls fail or time out. The kernel binary is not published as an npm package; build it from source or point `WHIMSICALITY_KERNEL_BIN` to an existing binary.

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

The test suite builds the server and tests it through the MCP stdio protocol, including simultaneous long-lived processes.

## License

MIT
