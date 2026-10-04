/**
 * M10 — shared types for the orchestrator mechanism.
 *
 * Self-contained (`mechanisms/` 铁律 #1): new files only, no dependency, and it
 * never edits the kernel. It reuses kernel types (`Usage`, `ChatMessage`) through
 * relative imports and nothing else.
 *
 * Vocabulary:
 *  - a **worker** is a fresh `Agent` (its own session, its own message array)
 *    spawned by the {@link Supervisor} to run one self-contained task;
 *  - the **registry** is the in-memory ledger of worker records;
 *  - the **mailbox** is the durable, FIFO, per-run message queue that carries
 *    questions / replies / escalations / completion notices between workers and
 *    the coordinator;
 *  - a **delivery** is one `deliverNext`/`wait` hand-out of a mailbox message.
 *    A delivery that is not `ack`ed is replayed on the next delivery attempt.
 */

import type { Usage } from "../../types.js";

/** Lifecycle status of a worker. */
export type WorkerStatus =
  | "starting"
  | "running"
  | "blocked"
  | "done"
  | "failed";

/** One recorded status change. The registry keeps an append-only list. */
export interface WorkerTransition {
  /** Previous status (`undefined` for the initial transition at `add`). */
  from?: WorkerStatus;
  to: WorkerStatus;
  at: number;
  /** Optional human-readable cause ("spawned", "awaiting coordinator reply", …). */
  reason?: string;
}

/**
 * The frozen worker record consumed by the later INT wave. `transitions` is the
 * status-transition log required by the brief.
 */
export interface WorkerRecord {
  id: string;
  name: string;
  task: string;
  status: WorkerStatus;
  sessionId?: string;
  result?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  /** Every status change, oldest first. */
  transitions: WorkerTransition[];
}

/** Message kinds carried by the mailbox (mirrors Orca's vocabulary). */
export type MailboxMessageType =
  | "question"
  | "reply"
  | "escalation"
  | "worker_done"
  | "note";

/** Short alias kept for call sites that prefer it. */
export type MailboxType = MailboxMessageType;

/**
 * One mailbox message. `acked` is the delivery guard: an unacked message is
 * replayed, which is exactly why Orca requires `--ack` after every delivery.
 */
export interface MailboxMessage {
  id: string;
  from: string;
  to: string;
  type: MailboxMessageType;
  subject?: string;
  body: string;
  at: number;
  acked: boolean;
  /** Observability: how many times this message was handed out. */
  deliveries?: number;
  /** Observability: time of the most recent hand-out. */
  deliveredAt?: number;
}

/** Aggregated token/cost numbers over a set of provider calls. */
export interface WorkerUsageSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cost: number;
}

/**
 * Per-worker observability captured by the supervisor. This is *additive* to
 * {@link WorkerRecord}: it carries the raw `usage` records the token ledger
 * needs, which do not belong in the frozen registry record.
 */
export interface WorkerReport {
  id: string;
  sessionId: string;
  /** The worker's final assistant text (what the coordinator consumes). */
  text: string;
  /** Raw usage, one entry per provider call the worker made. */
  usages: Usage[];
  summary: WorkerUsageSummary;
  steps: number;
  toolCalls: number;
  /** Number of messages in the worker's own isolated context at the end. */
  messageCount: number;
  error?: string;
}
