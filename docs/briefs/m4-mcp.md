# Worker brief — M4 MCP context management

Read `docs/briefs/_wave-constraints.md` and `packages/core/src/mechanisms/README.md`
first; they are binding.

## Target

`packages/core/src/mechanisms/mcp/**`, `packages/server/scripts/mcp-experiment.ts`,
`docs/runs/m4-mcp.md`, `docs/mechanisms/mcp.md`.

## Change

1. **Hand-rolled MCP client (no SDK).** Implement the MCP stdio transport and the
   subset we need as JSON-RPC 2.0 over a child process's stdin/stdout:
   `initialize` handshake, `tools/list`, `tools/call`. Handle id correlation and
   newline-delimited JSON framing. Map `tools/list` entries to our `ToolSchema`
   shape with a **deterministic order**.
2. **Fixture server.** A tiny MCP server script (in the module's fixtures, launched
   with `node`) exposing a couple of echo tools so the client round-trips for real.
3. **Experiment.**
   - Prove the round-trip: print `tools/list` and a `tools/call` result.
   - Measure the **context cost**: how many tokens N injected MCP tool schemas add
     (try N = 1, 5, 20), using `usage.prompt_tokens`.
   - Measure the **cache impact**: with `OpenRouterClient` directly, add one tool to
     the set and show the `cached_tokens` drop (tie to `docs/runs/m1-cache.md` §1.3);
     also show that tool **order** changes matter.
4. **Teaching doc + findings.** `docs/mechanisms/mcp.md` explains eager MCP tool
   injection vs. progressive disclosure; `docs/runs/m4-mcp.md` holds the numbers.

## Constraints

As `_wave-constraints.md`. No `@modelcontextprotocol/sdk`; hand-roll it. New files
only; no dependency; no core/server/web edits.

## Ownership

You own the four paths under Target and nothing else.

## Observable acceptance

- A real JSON-RPC round-trip against the fixture server (list + call printed).
- Measured token cost per N tools and the cache-drop on tool-set change.
- `docs/runs/m4-mcp.md` answers MECHANISMS §6 Q2 and the §3 MCP claims.
- `pnpm typecheck` green; commit `M4: MCP context management`.

## Finish protocol

Send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/runs/m4-mcp.md`. Then stop.
