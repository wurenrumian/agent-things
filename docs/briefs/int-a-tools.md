# Worker brief — INT-A: wire tool-shaped mechanisms into the server

Unlike waves 1–2, this task **must edit shared files**: `packages/core/src/agent/loop.ts`,
`packages/core/src/tools/registry.ts`, `packages/core/src/events.ts`,
`packages/server/src/**`, `apps/web/**`, `docs/CONTRACT.md`. That is expected here;
there is no parallel sibling, so no conflict.

## Goal

Make the **skills**, **MCP**, and **subagent** mechanisms actually usable from the
HTTP server, and visible in the observatory. Today the server registers only the
five builtin tools.

## Read first

- `packages/core/src/mechanisms/README.md`
- `docs/mechanisms/skills.md`, `docs/mechanisms/mcp.md`, `docs/mechanisms/subagent.md`
- the `index.ts` of `packages/core/src/mechanisms/{skills,mcp,subagent}/`
- `docs/CONTRACT.md`, `packages/core/src/events.ts`, `packages/core/src/agent/loop.ts`,
  `packages/server/src/index.ts`, `packages/server/src/config.ts`

## Change

1. **Core seam — mechanism events (additive).**
   - Add to `AgentEvent`:
     `{ type: "mechanism"; name: string; phase: string; data?: unknown; at: number }`.
   - Add optional `events?: AgentEvent[]` to `ToolResult`; in the loop, after
     emitting `tool.result`, yield any `result.events` in order. This is how a
     mechanism tool surfaces progress without editing the loop per-mechanism.
2. **Composition root — `packages/server/src/compose.ts`.**
   Build the `ToolRegistry` and `AgentConfig` from config:
   - always: the builtin tools;
   - `use_skill` from `mechanisms/skills` when `SKILLS_DIR` contains skills;
   - MCP tools from `mechanisms/mcp` for each entry in `MCP_SERVERS` (JSON array
     of `{ name, command, args }`), connected at startup; a server that fails to
     connect is logged and skipped, never fatal;
   - `task` from `mechanisms/subagent` (nested `Agent`, builtin tools minus `task`).
   Keep registration **deterministically ordered** (the registry already sorts).
   Use `compose.ts` from `index.ts` instead of the inline registration.
3. **Config** (`config.ts`, additive): `SKILLS_DIR` (default `./skills`),
   `MCP_SERVERS` (JSON, default `[]`), `SUBAGENT_MAX_STEPS` (default 12).
4. **Routes (additive to `docs/CONTRACT.md`).**
   - `GET /api/mechanisms` → `{ skills: string[], mcpServers: string[], tools: string[] }`.
   Keep `/api/config` working (its `tools` now includes the new ones).
5. **Web (observatory).**
   - Render `mechanism` events in the Timeline (and, if cheap, a compact
     "Mechanisms" strip showing loaded skills / MCP servers / tool count).
   - Do not break existing tabs.
6. **Docs.** Update `docs/CONTRACT.md` (new event + route), and write
   `docs/runs/int-a.md` with the boot log and what `/api/mechanisms` returned.

## Constraints

- Add **no dependencies**. MCP client is already hand-rolled.
- Keep existing behavior when `MCP_SERVERS=[]` and `SKILLS_DIR` empty: the agent
  must still work exactly as before with the five builtin tools.
- Do not change the permission model or the compaction/hooks/checkpoint/scheduler
  mechanisms — that is INT-B.
- `pnpm typecheck` green across all packages; `pnpm --filter @agent/web build` green.

## Observable acceptance

- Server boots; `GET /api/config` lists `use_skill` and `task` (plus MCP tools if
  configured); `GET /api/mechanisms` returns the loaded skills/servers/tools.
- A short demo (script or curl) shows `/api/mechanisms` output; a smoke turn
  still completes when no skills/MCP are configured.
- `docs/runs/int-a.md` captures the evidence.
- Commit `INT-A: wire skills, MCP, subagent into the server` (do not push).

## Finish protocol

Send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/runs/int-a.md`. Then stop.
