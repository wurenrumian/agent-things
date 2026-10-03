/**
 * M7 — background & scheduled tasks.
 *
 * Self-contained mechanism (`mechanisms/` 铁律 #1): new files only, no
 * dependency, no kernel edit. Three pieces:
 *
 *  1. {@link Scheduler} — register one-shot (after/at) and interval tasks that
 *     run non-blocking, capture `{ status, result, error }`, support `cancel`,
 *     and deliver settled outcomes via `drain()` or `subscribe()`.
 *  2. {@link runInBackground} — the `run_in_background` shape: a handle returned
 *     immediately plus a `settled` promise / status query.
 *  3. {@link reinjectTaskOutcome} — turn a settled task into a `ChatMessage` for
 *     the session array (plus {@link taskOutcomeToEvent} for the event mapping).
 *
 * The demo lives in `packages/server/scripts/scheduler-experiment.ts`; findings
 * in `docs/runs/m7-scheduler.md`; teaching doc in `docs/mechanisms/scheduler.md`.
 */

export * from "./types.js";
export * from "./background.js";
export * from "./scheduler.js";
export * from "./reinject.js";
export { nextTaskId, errorText } from "./ids.js";
