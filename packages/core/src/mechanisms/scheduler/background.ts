/**
 * M7 — `runInBackground(fn)`.
 *
 * The shape a `run_in_background` tool needs: kick off a long function, return
 * a handle *immediately*, and let the caller keep working. The work starts on
 * the next macrotask (`setTimeout(..., 0)`), so the synchronous continuation
 * after `runInBackground(...)` always runs first — that is what "non-blocking"
 * means here, and the experiment asserts it.
 *
 * The returned handle never rejects: failures are captured into the outcome as
 * `status: "failed"` with an `error` string, so a background task can never
 * crash the caller with an unhandled rejection.
 */

import { clearTimeout as cancelTimer, setTimeout as delay } from "node:timers";
import { errorText, nextTaskId } from "./ids.js";
import type { TaskOutcome, TaskState } from "./types.js";

/** The function a background run executes. It receives an abort signal. */
export type BackgroundFn<T = unknown> = (signal: AbortSignal) => T | Promise<T>;

export interface RunInBackgroundOptions {
  /** Explicit id; otherwise generated. */
  id?: string;
  /** Human label used in outcomes / re-injection. Defaults to the id. */
  name?: string;
  /** Abort this run when an external signal fires. */
  signal?: AbortSignal;
  /** Observability hook, fired once when the run settles. */
  onSettled?: (outcome: TaskOutcome) => void;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

/** Handle returned by {@link runInBackground}. */
export interface BackgroundHandle<T = unknown> {
  readonly id: string;
  readonly name: string;
  status(): TaskState;
  result(): T | undefined;
  error(): string | undefined;
  isDone(): boolean;
  /** Best-effort cancel; aborts the signal and settles as `cancelled`. */
  cancel(): boolean;
  /** Resolves (never rejects) with the run's outcome. */
  readonly settled: Promise<TaskOutcome<T>>;
}

/**
 * Start `fn` in the background and return a handle immediately.
 *
 * ```ts
 * const job = runInBackground(async () => expensive());
 * // ... caller continues ...
 * const outcome = await job.settled; // status/result/error captured
 * ```
 */
export function runInBackground<T>(
  fn: BackgroundFn<T>,
  opts: RunInBackgroundOptions = {},
): BackgroundHandle<T> {
  const now = opts.now ?? Date.now;
  const id = opts.id ?? nextTaskId("bg");
  const name = opts.name ?? id;
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];

  let state: TaskState = "scheduled";
  let resultValue: T | undefined;
  let errorValue: string | undefined;
  let attempts = 0;
  let runStartedAt: number | undefined;
  let finished = false;
  let timer: ReturnType<typeof delay> | undefined;

  let resolveSettled!: (outcome: TaskOutcome<T>) => void;
  const settled = new Promise<TaskOutcome<T>>((resolve) => {
    resolveSettled = resolve;
  });

  if (opts.signal) {
    if (opts.signal.aborted) {
      controller.abort(opts.signal.reason);
    } else {
      const onAbort = (): void => controller.abort(opts.signal?.reason);
      opts.signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => opts.signal?.removeEventListener("abort", onAbort));
    }
  }

  const finish = (
    status: TaskOutcome<T>["status"],
    result?: T,
    error?: string,
  ): void => {
    if (finished) return;
    finished = true;
    state = status;
    resultValue = result;
    errorValue = error;
    const finishedAt = now();
    const outcome: TaskOutcome<T> = {
      taskId: id,
      name,
      kind: "background",
      status,
      result,
      error,
      run: attempts,
      startedAt: runStartedAt ?? finishedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt - (runStartedAt ?? finishedAt)),
    };
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch {
        /* a cleanup must never mask the outcome */
      }
    }
    resolveSettled(outcome);
    try {
      opts.onSettled?.(outcome as TaskOutcome);
    } catch {
      /* the observer must never crash the background run */
    }
  };

  const start = (): void => {
    if (finished) return;
    if (controller.signal.aborted) {
      finish("cancelled", undefined, "cancelled before start");
      return;
    }
    state = "running";
    attempts += 1;
    runStartedAt = now();
    let returned: T | Promise<T>;
    try {
      returned = fn(controller.signal);
    } catch (err) {
      finish("failed", undefined, errorText(err));
      return;
    }
    Promise.resolve(returned).then(
      (value) => {
        if (controller.signal.aborted) {
          finish("cancelled", undefined, "cancelled while running");
        } else {
          finish("succeeded", value);
        }
      },
      (err) => {
        if (controller.signal.aborted) {
          finish("cancelled", undefined, "cancelled while running");
        } else {
          finish("failed", undefined, errorText(err));
        }
      },
    );
  };

  // Next macrotask: guarantees the caller's synchronous continuation runs first.
  timer = delay(start, 0);

  return {
    id,
    name,
    status: () => state,
    result: () => resultValue,
    error: () => errorValue,
    isDone: () => finished,
    cancel: () => {
      if (finished) return false;
      if (timer) {
        cancelTimer(timer);
        timer = undefined;
      }
      controller.abort(new Error("cancelled"));
      finish("cancelled", undefined, "cancelled");
      return true;
    },
    settled,
  };
}
