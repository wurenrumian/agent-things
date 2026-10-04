/**
 * M10 — the {@link WorkerRegistry}.
 *
 * The registry is the coordinator's memory of "who exists and in what state".
 * It is deliberately dumb: a map of {@link WorkerRecord} plus an append-only
 * status-transition log. Every `update` that changes `status` appends a
 * {@link WorkerTransition}, so the experiment can print the exact lifecycle
 * (`starting → running → blocked → running → done`) instead of guessing.
 *
 * Snapshots are deep-ish clones: callers never hold a live reference to an
 * internal record, so a returned record cannot be mutated behind the
 * registry's back.
 */

import { nextId } from "./ids.js";
import type { WorkerRecord, WorkerStatus, WorkerTransition } from "./types.js";

/** Input accepted by {@link WorkerRegistry.add}. */
export interface AddWorkerInput {
  id?: string;
  name: string;
  task: string;
  status?: WorkerStatus;
  sessionId?: string;
  startedAt?: number;
}

/** Patch accepted by {@link WorkerRegistry.update}. */
export interface WorkerPatch {
  name?: string;
  task?: string;
  status?: WorkerStatus;
  sessionId?: string;
  result?: string;
  error?: string;
  endedAt?: number;
}

export class WorkerRegistry {
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Register a worker. Generates an id when none is supplied. */
  add(input: AddWorkerInput): WorkerRecord {
    const id = input.id ?? nextId("worker");
    if (this.workers.has(id)) {
      throw new Error(`WorkerRegistry.add: duplicate worker id "${id}"`);
    }
    const status = input.status ?? "starting";
    const at = input.startedAt ?? this.now();
    const record: WorkerRecord = {
      id,
      name: input.name,
      task: input.task,
      status,
      sessionId: input.sessionId,
      startedAt: at,
      transitions: [{ to: status, at }],
    };
    this.workers.set(id, record);
    return cloneRecord(record);
  }

  /** Snapshot of one worker, or `undefined` when unknown. */
  get(id: string): WorkerRecord | undefined {
    const record = this.workers.get(id);
    return record ? cloneRecord(record) : undefined;
  }

  /** Snapshot of every worker, insertion order. */
  list(): WorkerRecord[] {
    return [...this.workers.values()].map(cloneRecord);
  }

  /**
   * Apply a patch. When `status` changes, a transition is appended. Returns the
   * updated snapshot, or `undefined` when the worker is unknown.
   */
  update(id: string, patch: WorkerPatch, reason?: string): WorkerRecord | undefined {
    const record = this.workers.get(id);
    if (!record) return undefined;

    if (patch.name !== undefined) record.name = patch.name;
    if (patch.task !== undefined) record.task = patch.task;
    if (patch.sessionId !== undefined) record.sessionId = patch.sessionId;
    if (patch.result !== undefined) record.result = patch.result;
    if (patch.error !== undefined) record.error = patch.error;
    if (patch.endedAt !== undefined) record.endedAt = patch.endedAt;

    if (patch.status !== undefined && patch.status !== record.status) {
      const from = record.status;
      record.status = patch.status;
      const transition: WorkerTransition = { from, to: patch.status, at: this.now() };
      if (reason !== undefined) transition.reason = reason;
      record.transitions.push(transition);
    } else if (reason !== undefined && patch.status !== undefined) {
      // Same-status update: keep the cause observable without a fake transition.
      const last = record.transitions[record.transitions.length - 1];
      if (last && last.to === record.status) last.reason = reason;
    }

    return cloneRecord(record);
  }

  /** Drop a worker entirely. Returns `true` when something was removed. */
  remove(id: string): boolean {
    return this.workers.delete(id);
  }

  /** Deep snapshot of the whole registry (safe to serialise / persist). */
  snapshot(): WorkerRecord[] {
    return this.list();
  }

  /** Number of tracked workers. */
  size(): number {
    return this.workers.size;
  }

  /** Drop every worker (used to reset between experiment legs). */
  clear(): void {
    this.workers.clear();
  }
}

function cloneRecord(record: WorkerRecord): WorkerRecord {
  return {
    ...record,
    transitions: record.transitions.map((t) => ({ ...t })),
  };
}
