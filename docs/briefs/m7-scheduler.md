# Worker brief — M7 Background & scheduled tasks

Read `docs/briefs/_wave2-constraints.md` and `packages/core/src/mechanisms/README.md`
first; they are binding. Prefer a demo that needs **no model call**; if you use one,
keep it to ≤ 5 calls.

## Target

`packages/core/src/mechanisms/scheduler/**`,
`packages/server/scripts/scheduler-experiment.ts`, `docs/runs/m7-scheduler.md`,
`docs/mechanisms/scheduler.md`.

## Change

1. **Scheduler** (`mechanisms/scheduler/`). Register tasks that are either
   one-shot (after a delay / at a timestamp) or interval-based. Tasks run in the
   **background without blocking** the caller; capture `{ status, result, error }`
   and support `cancel`. Provide a way to collect settled results (a `drain()` or
   an async subscription).
2. **Background run helper.** A `runInBackground(fn)` that starts a long task and
   returns a handle immediately, with a `settled` promise / status query — the shape
   a `run_in_background` tool would use.
3. **Result re-injection.** A function that turns a completed background/scheduled
   task into a message suitable to append to a session (and note, in the doc, how it
   would map to an event without editing `events.ts`).
4. **Demo** (`scripts/scheduler-experiment.ts`): (a) register a task that fires
   after ~1s and show it fires with its result captured + re-injected; (b) start a
   background task and show the caller continues immediately, then collect the
   result; (c) show `cancel` on a pending task.

## Constraints

As `_wave2-constraints.md`. Use `node:timers`/async; no dependencies. Do not edit
`events.ts` — describe the event mapping only.

## Ownership

You own the four paths under Target and nothing else.

## Observable acceptance

- The demo shows a scheduled task firing, a non-blocking background task completing,
  a captured result re-injected as a message, and a successful `cancel`.
- `docs/mechanisms/scheduler.md` + `docs/runs/m7-scheduler.md`.
- `pnpm typecheck` green; commit `M7: background & scheduled tasks`.

## Finish protocol

Send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/runs/m7-scheduler.md`. Then stop.
