# Worker brief — M0 web

You are implementing `apps/web` for the **agent-things** project: the
**context observatory**.

## Read first (source of truth)

1. `docs/CONTRACT.md` — the frozen HTTP + SSE contract and the UI requirements.
2. `packages/core/src/events.ts` — the `AgentEvent` vocabulary (copy the shapes
   you need locally; the web app must not import `@agent/core`).
3. `packages/core/src/types.ts` — message / usage shapes.

## What to build

`apps/web`: a Vite + React + TypeScript single-page app. Dev server on port
5173, proxying `/api` to `http://localhost:8787`.

Files to create:

- `apps/web/package.json` — name `@agent/web`, `"type": "module"`, scripts:
  `"dev": "vite"`, `"build": "tsc -b && vite build"`, `"typecheck": "tsc --noEmit"`.
  deps: `react` ^18, `react-dom` ^18.
  devDeps: `vite` ^5, `@vitejs/plugin-react` ^4, `typescript` ^5.6,
  `@types/react` ^18, `@types/react-dom` ^18.
- `apps/web/tsconfig.json`, `apps/web/vite.config.ts`, `apps/web/index.html`.
- `apps/web/src/main.tsx`, `apps/web/src/App.tsx`, `apps/web/src/api.ts`,
  `apps/web/src/types.ts`, `apps/web/src/styles.css`, and any components.

## Requirements

- Two panes. **Left**: the conversation (user / assistant / tool messages).
  **Right**: the context observatory, with tabs:
  - **Context** — from `context.compiled`: the full message list actually sent,
    plus the `breakdown` (system chars, message count, tool count, estimated
    tokens, labelled sections).
  - **Request** — from `request.sent`: the raw JSON request body, collapsible.
  - **Usage** — from `usage`: prompt / completion / total tokens,
    `cached_tokens`, `cache_write_tokens`, cost; accumulate across the turn and
    show a running total. Make cache hits visually obvious.
  - **Timeline** — every event in arrival order, terminal-style.
- Session picker: list sessions, create a new one, load existing events on select
  (`GET /api/sessions`, `POST /api/sessions`, `GET /api/sessions/:id/events`).
- Send box: `POST /api/sessions/:id/messages`, then consume the SSE stream via
  `fetch` + `ReadableStream` reader (EventSource cannot POST). Append events live.
- No component library. Hand-written CSS, clean and readable. Dark theme welcome.

## Boundaries

- **Do not modify** `packages/core`, `packages/server`, or `docs`.
- Do not add dependencies beyond those listed.

## Finish

1. `pnpm install` (from the repo root).
2. `pnpm --filter @agent/web typecheck` and fix all errors.
3. Commit with message `M0 web: context observatory`. Do not push.
