/**
 * M7 — shared types for background & scheduled tasks.
 *
 * This module is self-contained (`mechanisms/` 铁律 #1): new files only, no
 * dependency, and it never edits the kernel. It reuses kernel types
 * (`ChatMessage`) through a relative import in `reinject.ts` and nothing else.
 *
 * Vocabulary:
 *  - a **task** is a unit of work registered with the {@link Scheduler}. It is
 *    either one-shot (fires once after a delay / at a timestamp) or interval
 *    (fires repeatedly);
 *  - an **execution** is one invocation of the task's function;
 *  - an **outcome** is the immutable record of one terminated execution (or a
 *    cancellation). Outcomes are what `drain()` / `subscribe()` deliver.
 */

/** How a task repeats. */
export type TaskKind = "one-shot" | "interval" | "background";

/** Lifecycle state of a task (or of a standalone background run). */
export type TaskState =
  | "scheduled"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

/** Terminal status carried by an outcome. */
export type OutcomeStatus = "succeeded" | "failed" | "cancelled";

/** Anything a task function may return; may be async. */
export type TaskFn<T = unknown> = (signal: AbortSignal) => T | Promise<T>;

/** A mutable snapshot of a registered task, as returned by `handle.record()`. */
export interface TaskRecord<T = unknown> {
  id: string;
  name: string;
  kind: TaskKind;
  state: TaskState;
  /** Number of executions that started (a cancel before the first run is 0). */
  runs: number;
  /** Status of the most recent execution, if any. */
  lastStatus?: OutcomeStatus;
  /** Result of the most recent successful execution. */
  result?: T;
  /** Error message of the most recent failed execution. */
  error?: string;
  /** Wall-clock time (ms) the task was registered. */
  createdAt: number;
  /** Absolute ms timestamp of the next fire (one-shot target or next tick). */
  nextRunAt?: number;
  /** Interval in ms for `interval` tasks. */
  intervalMs?: number;
  lastStartedAt?: number;
  lastFinishedAt?: number;
  lastDurationMs?: number;
  /** Number of interval ticks skipped because the previous run was still busy. */
  skipped?: number;
}

/**
 * The immutable record of one terminated execution (or a cancellation).
 * `drain()` and `subscribe()` hand these out.
 */
export interface TaskOutcome<T = unknown> {
  taskId: string;
  name: string;
  kind: TaskKind;
  status: OutcomeStatus;
  result?: T;
  error?: string;
  /** 0 for a cancel before any run, else the 1-based execution index. */
  run: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}

/**
 * The public handle returned by every registration / {@link runInBackground}.
 * `settled` resolves with the *first* outcome of the task (the one-shot run, the
 * first interval tick, or a cancellation). Later interval outcomes are still
 * delivered through `Scheduler.drain()` / `Scheduler.subscribe()`.
 */
export interface TaskHandle<T = unknown> {
  readonly id: string;
  readonly name: string;
  readonly kind: TaskKind;
  status(): TaskState;
  record(): TaskRecord<T>;
  /** Returns `true` if the task was still active and is now cancelled. */
  cancel(): boolean;
  readonly settled: Promise<TaskOutcome<T>>;
}
