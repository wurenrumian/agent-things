# Worker brief — INT-B2: checkpoint + scheduler

Like INT-A/INT-B1, this edits shared files: `packages/core/src/agent/loop.ts`,
`packages/core/src/tools/registry.ts`, `packages/core/src/events.ts`,
`packages/server/src/**`, `apps/web/**`, `docs/CONTRACT.md`. Single worker, no
sibling.

## Goal

Wire the **M6 checkpoint** and **M7 scheduler** mechanisms so they work from the
HTTP server and are observable, **off/inert by default**.

## Read first

- `docs/mechanisms/permissions.md` (checkpoint section), `docs/mechanisms/scheduler.md`
- `packages/core/src/mechanisms/checkpoint/{index,store}.ts`
- `packages/core/src/mechanisms/scheduler/{index,types,scheduler,background,reinject}.ts`
- `packages/core/src/agent/loop.ts`, `tools/registry.ts`, `events.ts`
- `packages/server/src/{config,compose,index}.ts`, `docs/CONTRACT.md`, `docs/runs/int-b1.md`

## Change

### 1. Core seams (additive)

**`tools/registry.ts` — `ToolContext` gains (all optional)**
- `turnId?: string`, `sessionId?: string`,
  `checkpoints?: CheckpointStore` (import from `../mechanisms/checkpoint/index.js`).

**`loop.ts`**
- `AgentConfig` gains optional `checkpoints?: CheckpointStore`.
- Pass `turnId` (the loop's turn id), `sessionId`, and `config.checkpoints` into
  every `tool.execute(input, ctx)`. No other loop change.

**`events.ts`** — add the scheduler's proposed event as a real union variant
(shape it inline; do **not** import mechanism types into `events.ts`):
`{ type:"task.settled"; taskId:string; name:string; kind:"one-shot"|"interval";
status:"succeeded"|"failed"|"cancelled"; result?:unknown; error?:string;
run:number; at:number }`.

### 2. Server wiring

- `config.ts` (additive): `CHECKPOINT_DIR` (default `${DATA_DIR}/checkpoints`);
  `SCHEDULER_ENABLED` (default `true`).
- `compose.ts`:
  - Create `CheckpointStore.open(checkpointDir)` when checkpointing is used, put
    it on `agentConfig.checkpoints`, and **wrap `write_file` + `edit_file`** so
    that before executing they snapshot `input.path` resolved against `ctx.cwd`
    into `ctx.turnId` (`await ctx.checkpoints?.snapshot(path.resolve(ctx.cwd,
    String(input.path)), ctx.turnId)`). Leave all other tools untouched.
  - Create a `Scheduler`; expose it + the store on the runtime.
- `index.ts` routes (additive to `docs/CONTRACT.md`):
  - `GET /api/sessions/:id/checkpoints` → `{ turns: [{ turnId, files: [{ path,
    existed, size, hash }] }] }`.
  - `POST /api/sessions/:id/checkpoints/:turnId/restore` → `store.restoreTurn`,
    return the `RestoreReport` (byte-identical check via sha256).
  - `POST /api/sessions/:id/schedule` with `{ afterMs? , at?, intervalMs?,
    prompt }` (exactly one timing field) → register a Scheduler task whose fn
    runs a **fresh nested `Agent`** (same `agentConfig`, seeded from
    `store.getMessages(id)`), returns the final assistant text; on settle,
    `reinjectTaskOutcome(messages, outcome)` into the session store, persist, and
    append a `task.settled` event. Name the task with the session id.
  - `GET /api/sessions/:id/tasks` → `scheduler.list()`.
- When a scheduled task settles for a session with a **live** cached `Agent`,
  prefer appending to that agent's `messages` too and do not corrupt it.

### 3. Web

- Render `task.settled` in the Timeline (status color); `mechanism` already
  renders. Do not break existing tabs.

### 4. Docs

- Update `docs/CONTRACT.md` (new event, routes, env).
- Write `docs/runs/int-b2.md` with evidence (`sha256` before/after restore, the
  `task.settled` event + re-injected message).

## Constraints

- Add **no dependencies**.
- `CHECKPOINT_DIR`/`SCHEDULER_ENABLED` default must keep the current path; a
  fresh boot with no writes/schedules behaves exactly as before.
- `pnpm typecheck` green + `pnpm --filter @agent/web build` green.
- Prefer **incremental commits** (checkpoint, then scheduler) so partial work is
  mergeable; still finish with one `worker_done`.

## Observable acceptance

- A turn that calls `write_file` records a checkpoint turn; edit the file on
  disk, then restore → `RestoreReport.identical === true` and the on-disk
  sha256 matches the snapshot.
- `POST /api/sessions/:id/schedule {afterMs: 300, prompt: "..."}` → after the
  delay a `task.settled` event is persisted and a re-injected user message is in
  the session's messages.
- No-config smoke unchanged; `docs/runs/int-b2.md` has the evidence; commit
  `INT-B2: checkpoint + scheduler` (do not push).

## Finish protocol

`worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/runs/int-b2.md`. Then stop.
