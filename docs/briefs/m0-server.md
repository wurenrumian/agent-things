# Worker brief — M0 server

You are implementing `packages/server` for the **agent-things** project.

## Read first (source of truth)

1. `docs/CONTRACT.md` — the frozen HTTP + SSE contract. Implement it **exactly**.
2. `docs/ARCHITECTURE.md` §3 — core interfaces.
3. `packages/core/src/index.ts`, `packages/core/src/events.ts`,
   `packages/core/src/types.ts` — the `@agent/core` public API you must use.

## What to build

`packages/server`: a Hono HTTP server that wraps `@agent/core` and streams
`AgentEvent`s over SSE.

Files to create:

- `packages/server/package.json` — name `@agent/server`, `"type": "module"`,
  `"exports": { ".": "./src/index.ts" }`, scripts:
  `"dev": "tsx watch src/index.ts"`, `"start": "tsx src/index.ts"`,
  `"typecheck": "tsc -p tsconfig.json --noEmit"`.
  deps: `hono` ^4, `@hono/node-server` ^1, `@agent/core` `workspace:*`.
  devDeps: `tsx` ^4, `typescript` ^5.6, `@types/node` ^24.
- `packages/server/tsconfig.json` — extends `../../tsconfig.base.json`, includes `src`.
- `packages/server/src/index.ts` — the server (helpers may be split into `src/*.ts`).

## Requirements

- Implement every route and response shape in `docs/CONTRACT.md`.
- One `Agent` per session, kept in a `Map`. Lazily load messages from `Store`
  on first use. Config comes from env (`docs/CONTRACT.md`).
- Config loader: write a tiny `.env` parser (no `dotenv` dependency) that reads
  the repo-root `.env` if present and fills `process.env` for missing keys.
  Fail fast with a clear message if `OPENROUTER_API_KEY` is missing.
- `POST /api/sessions/:id/messages` streams `AgentEvent`s as SSE using
  `streamSSE` from `hono/streaming`. Frames: `event: <type>`, `data: <JSON>`.
  Pass `c.req.raw.signal` into `agent.run(input, signal)`. Persist events with
  `Store.appendEvents`, and on `turn.end` call `Store.saveMessages` + `Store.touch`.
- CORS: allow `http://localhost:5173` (use `hono/cors`).
- Bind with `@hono/node-server`'s `serve`, port from env (default 8787).
- `Store` db file: `${DATA_DIR}/agent.db`, `DATA_DIR` relative to the repo root.

## Boundaries

- **Do not modify** `packages/core`, `apps/web`, or `docs`.
- Do not add dependencies beyond those listed.

## Finish

1. `pnpm install` (from the repo root).
2. `pnpm --filter @agent/server typecheck` and fix all errors.
3. Commit with message `M0 server: HTTP+SSE`. Do not push.
