/**
 * M7 — the {@link Scheduler}.
 *
 * Register tasks that are one-shot (`after` a delay / `at` a timestamp) or
 * interval-based. Tasks run through {@link runInBackground}, so registration
 * never blocks the caller; every terminated execution is captured as a
 * {@link TaskOutcome} and delivered through `drain()` (pull) or `subscribe()`
 * (push). `cancel()` stops pending and running tasks.
 *
 * Design notes:
 *  - All timing goes through `node:timers`; no dependency, no kernel edit.
 *  - Every execution is bounded by an `AbortSignal`, so cancel is cooperative
 *    for long-running work and immediate for pending work.
 *  - Interval ticks are skipped (not queued) while a previous run is still in
 *    flight; the number skipped is recorded as `record.skipped`.
 */

import {
  clearInterval as cancelRepeat,
  clearTimeout as cancelTimer,
  setInterval as repeat,
  setTimeout as delay,
} from "node:timers";
import { runInBackground, type BackgroundHandle } from "./background.js";
import { nextTaskId } from "./ids.js";
import type {
  TaskFn,
  TaskHandle,
  TaskKind,
  TaskOutcome,
  TaskRecord,
} from "./types.js";

/** Per-registration options. */
export interface TaskOptions {
  /** Explicit id; otherwise generated from the prefix. */
  id?: string;
  /** Human label used in outcomes / re-injection. Defaults to the id. */
  name?: string;
  /** Prefix for generated ids (e.g. `after`, `every`). */
  idPrefix?: string;
  /** Cancel the task automatically when this signal fires. */
  signal?: AbortSignal;
}

export interface SchedulerOptions {
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Push hook fired for every outcome, in addition to the drain buffer. */
  onOutcome?: (outcome: TaskOutcome) => void;
  /** Cap on buffered outcomes kept for `drain()`. Oldest are dropped. */
  maxBuffered?: number;
}

/** Subscriber function for the push path. Returns an unsubscribe function. */
export type OutcomeListener = (outcome: TaskOutcome) => void;

interface TaskSlot {
  record: TaskRecord<unknown>;
  fn: TaskFn;
  timer?: ReturnType<typeof delay>;
  repeatTimer?: ReturnType<typeof repeat>;
  running: boolean;
  current?: BackgroundHandle<unknown>;
  settled: Promise<TaskOutcome<unknown>>;
  settledResolve: (outcome: TaskOutcome<unknown>) => void;
  settledResolved: boolean;
  signalCleanup?: () => void;
}

export class Scheduler {
  private readonly slots = new Map<string, TaskSlot>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly listeners = new Set<OutcomeListener>();
  private readonly now: () => number;
  private readonly onOutcome: ((outcome: TaskOutcome) => void) | undefined;
  private readonly maxBuffered: number;
  private buffer: TaskOutcome<unknown>[] = [];

  constructor(opts: SchedulerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.onOutcome = opts.onOutcome;
    this.maxBuffered = opts.maxBuffered ?? 1024;
  }

  /** Register a one-shot task that fires once after `delayMs`. */
  scheduleAfter<T>(
    delayMs: number,
    fn: TaskFn<T>,
    opts: TaskOptions = {},
  ): TaskHandle<T> {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError(`delayMs must be a finite number >= 0 (got ${delayMs})`);
    }
    const id = opts.id ?? nextTaskId(opts.idPrefix ?? "after");
    const slot = this.createSlot("one-shot", fn, opts.name ?? id, id, opts.signal);
    slot.record.nextRunAt = this.now() + delayMs;
    slot.timer = delay(() => {
      void this.runOneShot(id);
    }, delayMs);
    return this.createHandle<T>(id);
  }

  /** Register a one-shot task that fires at an absolute time. */
  scheduleAt<T>(
    when: number | Date,
    fn: TaskFn<T>,
    opts: TaskOptions = {},
  ): TaskHandle<T> {
    const target = when instanceof Date ? when.getTime() : when;
    if (!Number.isFinite(target)) {
      throw new RangeError(`"when" must be a finite timestamp or Date (got ${String(when)})`);
    }
    const id = opts.id ?? nextTaskId(opts.idPrefix ?? "at");
    const slot = this.createSlot("one-shot", fn, opts.name ?? id, id, opts.signal);
    slot.record.nextRunAt = target;
    const delayMs = Math.max(0, target - this.now());
    slot.timer = delay(() => {
      void this.runOneShot(id);
    }, delayMs);
    return this.createHandle<T>(id);
  }

  /**
   * Register an interval task that fires every `intervalMs` (first fire after
   * one interval). Ticks are skipped while a previous run is still busy.
   */
  scheduleInterval<T>(
    intervalMs: number,
    fn: TaskFn<T>,
    opts: TaskOptions = {},
  ): TaskHandle<T> {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new RangeError(`intervalMs must be a finite number > 0 (got ${intervalMs})`);
    }
    const id = opts.id ?? nextTaskId(opts.idPrefix ?? "every");
    const slot = this.createSlot("interval", fn, opts.name ?? id, id, opts.signal);
    slot.record.intervalMs = intervalMs;
    slot.record.nextRunAt = this.now() + intervalMs;
    slot.repeatTimer = repeat(() => {
      void this.tickInterval(id);
    }, intervalMs);
    return this.createHandle<T>(id);
  }

  /** Cancel a task. Returns `true` only if it was still active. */
  cancel(id: string): boolean {
    const slot = this.slots.get(id);
    if (!slot) return false;
    const { state } = slot.record;
    if (state === "cancelled" || state === "succeeded" || state === "failed") {
      return false;
    }
    if (slot.timer) {
      cancelTimer(slot.timer);
      slot.timer = undefined;
    }
    if (slot.repeatTimer) {
      cancelRepeat(slot.repeatTimer);
      slot.repeatTimer = undefined;
    }
    slot.signalCleanup?.();
    slot.signalCleanup = undefined;
    slot.record.state = "cancelled";
    slot.record.lastStatus = "cancelled";
    slot.record.nextRunAt = undefined;

    if (slot.running && slot.current) {
      // The in-flight run settles as `cancelled`; execute()'s await finalizes.
      slot.current.cancel();
    } else {
      const at = this.now();
      this.emit(slot, {
        taskId: slot.record.id,
        name: slot.record.name,
        kind: slot.record.kind,
        status: "cancelled",
        run: slot.record.runs,
        startedAt: at,
        finishedAt: at,
        durationMs: 0,
      });
    }
    return true;
  }

  /** Pull every outcome buffered since the last `drain()`. */
  drain(): TaskOutcome[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  /** Push every future outcome to `listener`; returns an unsubscribe fn. */
  subscribe(listener: OutcomeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot of one task's mutable record. */
  get(id: string): TaskRecord | undefined {
    const slot = this.slots.get(id);
    return slot ? { ...slot.record } : undefined;
  }

  /** Snapshot of every registered task record. */
  list(): TaskRecord[] {
    return [...this.slots.values()].map((slot) => ({ ...slot.record }));
  }

  /** Number of registered tasks (including settled ones). */
  size(): number {
    return this.slots.size;
  }

  /**
   * Stop every timer, cancel active tasks, and resolve once all in-flight runs
   * have settled. Safe to call more than once.
   */
  async shutdown(): Promise<void> {
    for (const slot of [...this.slots.values()]) {
      if (slot.timer) {
        cancelTimer(slot.timer);
        slot.timer = undefined;
      }
      if (slot.repeatTimer) {
        cancelRepeat(slot.repeatTimer);
        slot.repeatTimer = undefined;
      }
      const { state } = slot.record;
      if (state === "scheduled" || state === "running") this.cancel(slot.record.id);
    }
    await Promise.allSettled([...this.inFlight]);
  }

  /* -------------------------------------------------------------- internals */

  private createSlot<T>(
    kind: TaskKind,
    fn: TaskFn<T>,
    name: string,
    id: string,
    signal: AbortSignal | undefined,
  ): TaskSlot {
    let settledResolve!: (outcome: TaskOutcome<unknown>) => void;
    const settled = new Promise<TaskOutcome<unknown>>((resolve) => {
      settledResolve = resolve;
    });
    const record: TaskRecord<unknown> = {
      id,
      name,
      kind,
      state: "scheduled",
      runs: 0,
      createdAt: this.now(),
    };
    const slot: TaskSlot = {
      record,
      fn: fn as TaskFn,
      running: false,
      settled,
      settledResolve,
      settledResolved: false,
    };
    if (signal) {
      if (signal.aborted) {
        // Cancel after the current synchronous registration returns.
        queueMicrotask(() => {
          this.cancel(id);
        });
      } else {
        const onAbort = (): void => {
          this.cancel(id);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        slot.signalCleanup = () => signal.removeEventListener("abort", onAbort);
      }
    }
    this.slots.set(id, slot);
    return slot;
  }

  private createHandle<T>(id: string): TaskHandle<T> {
    const slot = this.slots.get(id);
    if (!slot) throw new Error(`createHandle: unknown task ${id}`);
    const resolve = (): TaskRecord<unknown> => this.slots.get(id)?.record ?? slot.record;
    return {
      id,
      name: slot.record.name,
      kind: slot.record.kind,
      status: () => this.slots.get(id)?.record.state ?? "cancelled",
      record: () => ({ ...resolve() }) as TaskRecord<T>,
      cancel: () => this.cancel(id),
      settled: slot.settled as Promise<TaskOutcome<T>>,
    };
  }

  private async runOneShot(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot || slot.record.state === "cancelled") return;
    slot.timer = undefined;
    slot.running = true;
    await this.execute(slot, slot.record.runs + 1);
  }

  private async tickInterval(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot || slot.record.state === "cancelled") return;
    if (slot.running) {
      slot.record.skipped = (slot.record.skipped ?? 0) + 1;
      return;
    }
    slot.running = true;
    await this.execute(slot, slot.record.runs + 1);
  }

  private async execute(slot: TaskSlot, runIndex: number): Promise<void> {
    const record = slot.record;
    record.runs = runIndex;
    record.state = "running";
    const bg = runInBackground<unknown>((signal) => slot.fn(signal), {
      name: record.name,
      now: this.now,
    });
    slot.current = bg;
    this.inFlight.add(bg.settled);
    const raw = await bg.settled;
    this.inFlight.delete(bg.settled);
    slot.current = undefined;
    slot.running = false;
    this.finalize(slot, {
      taskId: record.id,
      name: record.name,
      kind: record.kind,
      status: raw.status,
      result: raw.result,
      error: raw.error,
      run: runIndex,
      startedAt: raw.startedAt,
      finishedAt: raw.finishedAt,
      durationMs: raw.durationMs,
    });
  }

  private finalize(slot: TaskSlot, outcome: TaskOutcome<unknown>): void {
    const record = slot.record;
    record.lastStatus = outcome.status;
    record.result = outcome.result;
    record.error = outcome.error;
    record.lastStartedAt = outcome.startedAt;
    record.lastFinishedAt = outcome.finishedAt;
    record.lastDurationMs = outcome.durationMs;

    if (outcome.status === "cancelled") {
      record.state = "cancelled";
      record.nextRunAt = undefined;
    } else if (record.kind === "interval") {
      record.state = "scheduled";
      if (record.intervalMs !== undefined) {
        record.nextRunAt = this.now() + record.intervalMs;
      }
    } else {
      record.state = outcome.status;
      record.nextRunAt = undefined;
    }

    slot.signalCleanup?.();
    slot.signalCleanup = undefined;
    this.emit(slot, outcome);
  }

  private emit(slot: TaskSlot, outcome: TaskOutcome<unknown>): void {
    this.buffer.push(outcome);
    if (this.buffer.length > this.maxBuffered) this.buffer.shift();
    if (!slot.settledResolved) {
      slot.settledResolved = true;
      slot.settledResolve(outcome);
    }
    if (this.onOutcome) {
      try {
        this.onOutcome(outcome);
      } catch {
        /* an observer must never crash the scheduler */
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(outcome);
      } catch {
        /* a subscriber must never crash the scheduler */
      }
    }
  }
}

/** Convenience factory. */
export function createScheduler(opts: SchedulerOptions = {}): Scheduler {
  return new Scheduler(opts);
}
