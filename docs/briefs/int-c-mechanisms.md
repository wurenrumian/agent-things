# Worker brief — INT-C: wire M9 memory + M10 orchestrator + M11 tool-search

Unlike the wave-3 briefs, **this** integration wave may (and must) edit the
shared core/server/web/doc files. You are the only worker in this wave, so
there is no merge conflict. Work on top of `master`, which already contains
M9/M10/M11 merged (commits `1c04efe`, `392888f`, `8eac7ab`).

Read first: `packages/core/src/mechanisms/README.md`,
`packages/core/src/mechanisms/{memory,orchestrator,tool-search}/index.ts`
(each documents its frozen public API + wiring snippet), `docs/ARCHITECTURE.md`,
`docs/CONTRACT.md`, `docs/MECHANISMS.md` §7, `docs/runs/{m9-memory,m10-orchestrator,m11-tool-search}.md`,
`packages/server/src/{config,compose,index}.ts`, `packages/core/src/agent/loop.ts`.

## Target (shared files — you own these for this wave)

- `packages/server/src/config.ts`
- `packages/server/src/compose.ts`
- `packages/server/src/index.ts`
- `packages/core/src/events.ts` (append-only, only if truly needed)
- `apps/web/**` (minimal)
- `docs/CONTRACT.md`, `docs/ROADMAP.md`, `docs/MECHANISMS.md`, `docs/STATE.md`, `README.md`
- `docs/runs/int-c.md` (new; your report)

**Do not touch** the three mechanism directories under
`packages/core/src/mechanisms/{memory,orchestrator,tool-search}/` or
`packages/server/scripts/*-experiment.ts` (read-only), and do not edit
`docs/briefs/**`.

## Change

Follow the repo's INT pattern: **unconfigured ⇒ behaviour byte-for-byte
unchanged**. Every new mechanism is opt-in via env.

1. **Config** (`config.ts`) — add, parsed with the existing helpers:
   - `MEMORY_ENABLED` (bool, default `false`), `MEMORY_DIR` (default
     `${DATA_DIR}/memory`), `MEMORY_SYSTEM_INJECT` (bool, default `false`).
   - `ORCHESTRATOR_ENABLED` (bool, default `false`), `ORCHESTRATOR_MAX_WORKERS`
     (positive int, default `4`).
   - `TOOL_SEARCH_ENABLED` (bool, default `false`).
2. **Compose** (`compose.ts`) — extend `ComposedAgent` and wire:
   - **Memory (M9):** when `MEMORY_ENABLED`, `MemoryStore.open(memoryDir)`,
     register one `createMemoryTool(store)` (tail injection — cache-safe, per
     `docs/runs/m9-memory.md`). Only when `MEMORY_SYSTEM_INJECT` is also true,
     append `memorySystemSuffix(store.all())` at the very end of the system
     prompt; because that requires `systemPromptOverride`, build the base with
     the exported `buildSystemPrompt({ cwd, platform })` and append the suffix —
     document the cache caveat in a comment. Expose `memories: { dir, count }`
     on `ComposedAgent`.
   - **Orchestrator (M10):** when `ORCHESTRATOR_ENABLED`, create a
     `Supervisor({ client, model, cwd, onMessage })` and register
     `createOrchestratorTools(supervisor)` on the parent registry. Route
     `onMessage` to the server via a small callback (see below); expose the
     `Supervisor` on `ComposedAgent` and close it in `close()`.
   - **Tool-search (M11):** when `TOOL_SEARCH_ENABLED`, wrap the **fully built**
     final registry with `createToolSearchRegistry(realRegistry)` so the parent
     Agent sees only `tool_search`/`tool_call`. Note the permission caveat from
     the mechanism doc in a comment.
   - Tool ordering must stay `ToolRegistry.list()`-deterministic
     (cache-stability rule, `docs/runs/m1-cache.md`).
3. **Server** (`index.ts`) — extend `Runtime` + `GET /api/mechanisms` (add
   `memory`, `orchestrator`, `toolSearch` status), and add:
   - `GET /api/memories` → `{ dir, count, entries }` (or `{ enabled:false }`).
   - `GET /api/workers` → `Supervisor` registry snapshot (or `{ enabled:false }`).
   - If worker messages need to outlive a turn, mirror the M7 pattern
     (`scheduler.subscribe` → `reinjectTaskOutcome` + `store.appendEvents`);
     otherwise reach through `GET /api/workers`. Keep it minimal and documented.
4. **Events** (`events.ts`) — prefer reusing the existing `mechanism` event and
   `ToolResult.events`; add a new event type **only** if genuinely needed, and
   keep it append-only (never rename/repurpose an existing field).
5. **Web** (minimal, best-effort): surface the new server info — at least a
   small "Workers"/"Memory" read-out (can reuse the existing mechanisms strip /
   a simple panel). `pnpm --filter @agent/web build` must stay green.
6. **Docs**: `docs/CONTRACT.md` (new env + routes), `docs/ROADMAP.md` (mark
   INT-C), `docs/MECHANISMS.md` §7 (backfill the M9/M10/M11 **measured**
   results from their run docs), `docs/STATE.md` (status + handoff), `README.md`
   (mechanism table rows for M9/M10/M11 with env switches).

## Constraints

- No new dependency. Hand-roll if needed.
- `.env` is gitignored; never commit it.
- Keep API calls bounded; the integration test needs at most a couple of real
  turns. Back off on 429.
- Preserve the "unconfigured ⇒ unchanged" invariant: with all new env unset,
  `pnpm typecheck` and a server boot must behave exactly as today.

## Ownership

The shared paths under Target, plus `docs/runs/int-c.md`. Nothing else.

## Observable acceptance

- `pnpm typecheck` green (core/server/web/cli) **and**
  `pnpm --filter @agent/web build` green.
- Server boots with each new flag off (unchanged) and on (no crash); logs name
  the enabled mechanisms.
- With `MEMORY_ENABLED=true`, a real turn can call the `memory` tool and
  `GET /api/memories` shows the saved entry.
- With `ORCHESTRATOR_ENABLED=true`, `GET /api/workers` returns the supervisor
  snapshot; with `TOOL_SEARCH_ENABLED=true`, `/api/config` tools list is exactly
  `tool_search` + `tool_call` plus builtins kept inside the facade.
- `docs/runs/int-c.md` records the wiring + the boot/route evidence.
- Commit `INT-C: wire memory + orchestrator + tool-search`.

## Finish protocol

Send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/runs/int-c.md`. Then stop.
