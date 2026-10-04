# Worker brief — M11 Lazy tool exposure (tool search / code-mode facade)

Read `docs/briefs/_wave3-constraints.md` and
`packages/core/src/mechanisms/README.md` first; they are binding. Also read
`docs/runs/m4-mcp.md` (eager tool injection ≈ 165 token/tool; add/reorder →
cache collapse), `docs/runs/m1-cache.md`, and `packages/core/src/tools/registry.ts`.

## Target

- `packages/core/src/mechanisms/tool-search/**`
- `packages/server/scripts/tool-search-experiment.ts`
- `docs/runs/m11-tool-search.md`
- `docs/mechanisms/tool-search.md`

## The idea (teach this)

Eager schema injection is the MCP default: every tool's full JSON schema sits in
the request prefix on every call, and changing the set/order destroys the prompt
cache. The alternative — used by newer agents — is **lazy exposure**: give the
model a tiny searchable facade and load a tool's schema only when it is needed.

## Change

1. **`ToolIndex`** — index a list of `ToolDef`s by name + description + parameter
   names. `search(query, limit)` returns ranked matches with a **deterministic**
   score (keyword overlap; no embeddings). Expose each match's name,
   description, and parameter signature.
2. **`createToolSearchTools(realTools: ToolDef[])`** — return exactly two
   `ToolDef`s:
   - `tool_search(query)` — returns the matching tools' signatures/descriptions
     as text (this enters context **on demand**, at the tail).
   - `tool_call(name, arguments)` — looks up the real tool, rejects unknown
     names, executes it, and returns its output.
   The parent `Agent` is registered with **only these two tools**, so the full
   schemas never enter the request prefix.
3. Keep the facade deterministic and document the public API in `index.ts` so
   the later integration wave can enable it (e.g. by wrapping a full
   `ToolRegistry`).

## Experiment (real usage required, bounded)

Run the **same task** two ways against the real model:

- **(a) eager:** `Agent` with the full registry of N tools (builtins + several
  stand-in MCP-like tools, reusing the M4 fixture style if present).
- **(b) lazy:** `Agent` whose registry contains only the two facade tools.

Report per call: `prompt_tokens`, `usage.prompt_tokens_details.cached_tokens`,
and total tokens/cost; and whether the task still completes in both modes.
Quantify the prefix-token saving and the cache effect across ≥3 calls.

## Answer in the run doc

- Tokens saved by the facade `vs.` eager N-tool injection.
- Whether the facade keeps the prefix **stable** across turns (and why).
- The trade-off: an extra round-trip for search `vs.` a smaller, stabler prefix.

## Constraints

As `_wave3-constraints.md`. New files only; no dependency; no
core/server/web/events edits. Keep API usage bounded (≤ ~30 calls); back off on
429.

## Ownership

You own the four paths under Target and nothing else.

## Observable acceptance

- Both modes run end-to-end against the real model; the same task completes.
- `docs/runs/m11-tool-search.md` contains the token/cache ledger.
- `docs/mechanisms/tool-search.md` teaches the facade and the trade-off.
- `pnpm typecheck` green; commit `M11: lazy tool exposure`.

## Finish protocol

Send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/runs/m11-tool-search.md`.
Then stop.
