/**
 * M11 — lazy tool exposure (tool search / code-mode facade).
 *
 * Eager schema injection is the MCP default: every tool's full JSON schema sits
 * in the request prefix on every call, and changing the set or order destroys
 * the prompt cache (docs/runs/m4-mcp.md). This mechanism is the alternative:
 * keep a tiny searchable facade resident and load a tool's schema only when it
 * is needed.
 *
 * ## Public API
 *
 * - `ToolIndex` — deterministic keyword index over `ToolDef`s (name +
 *   description + parameter names; no embeddings). `search(query, limit)`
 *   returns ranked `ToolMatch` records with each tool's signature.
 * - `createToolSearchTools(source, options?)` — returns **exactly two**
 *   `ToolDef`s: `tool_search(query)` and `tool_call(name, arguments)`.
 * - `createToolSearchRegistry(source, options?)` — wraps a real tool set (a
 *   `ToolDef[]` or a full `ToolRegistry`) in a `ToolRegistry` containing only
 *   the two facade tools; register that on the `Agent` and the N real schemas
 *   never enter the request prefix.
 * - `parameterSignature(name, parameters)` / `tokenize(text)` — the small
 *   helpers the index is built from, exported for reuse and testing.
 *
 * ## Wiring (later integration wave)
 *
 * ```ts
 * import { createToolSearchRegistry } from "./mechanisms/tool-search/index.js";
 * const tools = createToolSearchRegistry(realRegistry); // the full set
 * // new Agent({ ...config, tools }, sessionId) sees only tool_search/tool_call
 * ```
 *
 * A real `tool_call` executes the underlying tool with the caller's
 * `ToolContext`; the facade's own `readOnly` flag drives permission, so an
 * integration that needs per-tool permissions should gate `tool_call` on the
 * resolved inner tool instead of on the facade alone.
 *
 * Self-contained by design: no dependencies, only relative core imports.
 */

export * from "./tool-index.js";
export * from "./facade.js";
