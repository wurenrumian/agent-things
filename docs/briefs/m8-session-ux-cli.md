# Worker brief — M8: session UX (fork, diff, cost) + CLI

Edits shared files (`packages/core/src/store/session.ts`,
`packages/core/src/index.ts`, `packages/server/src/**`, `apps/web/**`,
`docs/CONTRACT.md`) and adds a **new workspace package** `packages/cli`. Single
worker, no sibling.

## Goal

Ship the last milestone: **session fork**, a **file-diff view**, a polished
**cost panel**, and an `agent-things` **CLI that drives the same `@agent/core`
kernel**.

## Read first

- `docs/ROADMAP.md` (M8), `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/CONTRACT.md`
- `packages/core/src/store/session.ts`, `packages/core/src/agent/loop.ts`,
  `packages/core/src/tools/builtin.ts`, `packages/core/src/provider/openrouter.ts`,
  `packages/core/src/index.ts`
- `packages/server/src/{index,compose,config}.ts`
- `apps/web/src/components/{UsageTab,TimelineTab,Observatory,SessionPicker,Conversation}.tsx`,
  `apps/web/src/{api,types}.ts`

## Change

### 1. Session fork (core + server + web)

- `Store.forkSession(sourceId, opts?: { atMessageIndex?: number; title?: string }): SessionMeta`
  — creates a new session whose messages are `source.messages.slice(0, atMessageIndex ?? end)`,
  fresh event log, title default `${source.title} (fork)`. Return the meta.
- Route `POST /api/sessions/:id/fork` (body `{ atMessageIndex?, title? }`) → the
  new `SessionMeta` (404 if unknown). Additive to `docs/CONTRACT.md`.
- Web: a **Fork** action (from the latest message, and/or per assistant turn) that
  calls the route and selects the new session.

### 2. File diff (core + server + web)

- Add a pure `unifiedDiff(oldText, newText, opts?: { context?: number; maxChars?: number }): string`
  (no dependency; LCS-based line diff; cap output). Put it in `packages/core/src/diff.ts`
  and export it from `core/src/index.ts`.
- In `compose.ts`, extend the existing `write_file`/`edit_file` wrapper:
  read the target (resolve against `ctx.cwd`; missing = `""`) **before** and
  **after** execution; when it changed, append a `mechanism` event
  `{ name:"diff", phase:"file", data:{ path, added, removed, patch } }` to the
  returned `ToolResult.events`. Observability only — never enters the model
  context. Emit nothing when there is no change.
- Web: a **Diff** tab that collects `mechanism` `name==="diff"` events and renders
  each patch (monospace; `+` green / `-` red / context dim). Only add the tab when
  at least one diff exists (or show an empty state).

### 3. Cost panel (web, polish)

- The `UsageTab` already shows running hit%/cost — keep it, and make sure the
  session summary surfaces **total prompt/completion/cached tokens, hit rate, and
  total cost** in one headline. Small, tasteful additions only.

### 4. CLI — new package `packages/cli`

- `package.json` mirroring `packages/server`'s shape: `name @agent/cli`,
  `"bin": { "agent-things": "./src/index.ts" }`, scripts `start`/`typecheck`,
  deps `@agent/core: workspace:*`, devDeps `@types/node`, `tsx`, `typescript`.
  Add `tsconfig.json` extending `../../tsconfig.base.json`.
- `src/index.ts`: a tiny hand-written arg parser (`--cwd`, `--model`,
  `--permission-mode`, `--message`, `--help`); load the repo-root `.env` (small
  local loader — do **not** import the server); build `OpenRouterClient` +
  `ToolRegistry` from `builtinTools()`; construct `Agent` (same kernel); stream
  `AgentEvent`s to the terminal (text deltas inline; tool call/result and
  usage/cost as lines); support a one-shot `--message` and a `node:readline`
  REPL otherwise. No new runtime deps beyond the workspace link + `tsx`.

## Constraints

- Add **no new third-party runtime dependency**; `tsx` is the only new devDep
  (already in the pnpm store). Run `pnpm install` in the worktree so the
  lockfile + workspace link are correct, and commit the updated
  `pnpm-lock.yaml`.
- Default behavior of the existing server/web must not regress; the fork/diff
  additions are additive.
- `pnpm typecheck` green across **all** packages (core/server/web/cli) and
  `pnpm --filter @agent/web build` green.
- Prefer **incremental commits** (fork → diff → cost → CLI), each typecheck-green.
- Do not touch the mechanism modules.

## Observable acceptance

- `POST /api/sessions/:id/fork {atMessageIndex:1}` returns a new session whose
  messages equal the source's first message; the web Fork action works.
- A real turn that writes a file emits a `mechanism` `diff` event with a
  `+`/`-` patch; the Diff tab renders it.
- `pnpm --filter @agent/cli start "list the files here"` runs a real turn with
  `xiaomi/mimo-v2.6-flash`, streams events, prints a usage/cost line, and exits;
  `--help` prints usage.
- `docs/runs/m8.md` captures all evidence; commit `M8: fork, diff, cost + CLI`
  (do not push).

## Finish protocol

`worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/runs/m8.md`. Then stop.
