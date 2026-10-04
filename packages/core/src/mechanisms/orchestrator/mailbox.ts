/**
 * M10 — the {@link Mailbox}.
 *
 * A durable, FIFO, per-run message queue with **delivery + ack + replay**. This
 * is the piece that makes Orca-style coordination work without a PTY: workers
 * and the coordinator exchange structured messages instead of scraping a
 * terminal.
 *
 * The one behaviour worth teaching is replay. `deliverNext` / `wait` hand out
 * the **oldest unacked** matching message; handing it out does *not* consume it.
 * It is consumed only by `ack(id)`. So if a consumer reads a message and forgets
 * to ack, the very next delivery returns the same message again — exactly why
 * Orca requires `--ack` after every `check`.
 *
 * Durability is hand-rolled (no dependency): mutations append one JSON line to
 * an ops log (`{op:"send",…}` / `{op:"ack",…}`), and construction folds the log
 * back into memory. Absent `file`, the mailbox is in-memory only.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay, clearTimeout as cancelTimer } from "node:timers";
import path from "node:path";
import { nextId } from "./ids.js";
import type { MailboxMessage, MailboxMessageType } from "./types.js";

/** Optional recipient/sender filter for delivery and pending queries. */
export interface MailboxFilter {
  to?: string;
  from?: string;
}

/** Input accepted by {@link Mailbox.send}. */
export interface SendInput {
  id?: string;
  from: string;
  to: string;
  type: MailboxMessageType;
  subject?: string;
  body: string;
  at?: number;
  acked?: boolean;
}

export interface MailboxOptions {
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Durable ops-log file (JSONL). Absent ⇒ in-memory only. */
  file?: string;
  /** Handy sugar for `subscribe`; fired after every `send`. */
  onSend?: (message: MailboxMessage) => void;
}

interface Waiter {
  types: MailboxMessageType[] | undefined;
  filter: MailboxFilter | undefined;
  resolve: (message: MailboxMessage | null) => void;
  timer?: ReturnType<typeof delay>;
  done: boolean;
}

/** One line of the durable ops log. */
type LogRecord =
  | { op: "send"; message: MailboxMessage }
  | { op: "ack"; id: string };

export class Mailbox {
  private readonly messages: MailboxMessage[] = [];
  private readonly waiters = new Set<Waiter>();
  private readonly subscribers = new Set<(message: MailboxMessage) => void>();
  private readonly now: () => number;
  private readonly file: string | undefined;

  constructor(opts: MailboxOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.file = opts.file;
    if (opts.onSend) this.subscribers.add(opts.onSend);
    if (this.file) this.load();
  }

  /** Append a message to the queue and wake any matching waiter. */
  send(input: SendInput): MailboxMessage {
    const message: MailboxMessage = {
      id: input.id ?? nextId("msg"),
      from: input.from,
      to: input.to,
      type: input.type,
      subject: input.subject,
      body: input.body,
      at: input.at ?? this.now(),
      acked: input.acked ?? false,
      deliveries: 0,
    };
    this.messages.push(message);
    this.persist({ op: "send", message: { ...message } });
    const delivered = cloneMessage(message);
    this.notifyWaiters();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(cloneMessage(message));
      } catch {
        /* an observer must never break the mailbox */
      }
    }
    return delivered;
  }

  /**
   * Hand out the oldest **unacked** message matching `types` / `filter`.
   * The message is *not* consumed: a later call returns it again until `ack`.
   * Returns `null` when nothing matches. `deliveries`/`deliveredAt` record the
   * hand-out for the ledger.
   */
  deliverNext(
    types?: MailboxMessageType[],
    filter?: MailboxFilter,
  ): MailboxMessage | null {
    const message = this.messages.find(
      (m) => !m.acked && matches(m, types, filter),
    );
    if (!message) return null;
    message.deliveries = (message.deliveries ?? 0) + 1;
    message.deliveredAt = this.now();
    return cloneMessage(message);
  }

  /** Mark a message consumed. Returns `false` when unknown or already acked. */
  ack(id: string): boolean {
    const message = this.messages.find((m) => m.id === id);
    if (!message || message.acked) return false;
    message.acked = true;
    this.persist({ op: "ack", id });
    // Acking can unblock the next message for a waiting consumer.
    this.notifyWaiters();
    return true;
  }

  /** Every unacked message matching the filter, oldest first. */
  pending(
    types?: MailboxMessageType[],
    filter?: MailboxFilter,
  ): MailboxMessage[] {
    return this.messages
      .filter((m) => !m.acked && matches(m, types, filter))
      .map(cloneMessage);
  }

  /**
   * Resolve as soon as a matching message can be delivered, or with `null` when
   * `timeoutMs` elapses. Delivery uses the same replay rule as `deliverNext`: an
   * unacked message already handed out resolves a new waiter immediately.
   * `timeoutMs <= 0` means "check once, never block".
   */
  wait(
    types?: MailboxMessageType[],
    timeoutMs = 0,
    filter?: MailboxFilter,
  ): Promise<MailboxMessage | null> {
    const immediate = this.deliverNext(types, filter);
    if (immediate) return Promise.resolve(immediate);
    if (timeoutMs <= 0) return Promise.resolve(null);

    return new Promise<MailboxMessage | null>((resolve) => {
      const waiter: Waiter = {
        types,
        filter,
        resolve,
        done: false,
      };
      this.waiters.add(waiter);
      waiter.timer = delay(() => {
        if (waiter.done) return;
        waiter.done = true;
        this.waiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
    });
  }

  /** Total messages ever sent (acked or not). */
  size(): number {
    return this.messages.length;
  }

  /** Every message, oldest first (observability / transcripts). */
  all(): MailboxMessage[] {
    return this.messages.map(cloneMessage);
  }

  /** Look up one message by id. */
  get(id: string): MailboxMessage | undefined {
    const message = this.messages.find((m) => m.id === id);
    return message ? cloneMessage(message) : undefined;
  }

  /** Listen to every send. Returns an unsubscribe function. */
  subscribe(listener: (message: MailboxMessage) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /** Drop every waiter (used on shutdown so timers do not keep the process up). */
  dispose(): void {
    for (const waiter of this.waiters) {
      if (waiter.timer) cancelTimer(waiter.timer);
      if (!waiter.done) {
        waiter.done = true;
        waiter.resolve(null);
      }
    }
    this.waiters.clear();
  }

  /* -------------------------------------------------------------- internals */

  private notifyWaiters(): void {
    if (this.waiters.size === 0) return;
    // A message handed to one waiter in this pass must not double-deliver to
    // another; claim ids locally.
    const claimed = new Set<string>();
    for (const waiter of [...this.waiters]) {
      if (waiter.done) continue;
      const message = this.messages.find(
        (m) =>
          !m.acked &&
          !claimed.has(m.id) &&
          matches(m, waiter.types, waiter.filter),
      );
      if (!message) continue;
      claimed.add(message.id);
      message.deliveries = (message.deliveries ?? 0) + 1;
      message.deliveredAt = this.now();
      waiter.done = true;
      if (waiter.timer) cancelTimer(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(cloneMessage(message));
    }
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    const text = readFileSync(this.file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: LogRecord;
      try {
        record = JSON.parse(trimmed) as LogRecord;
      } catch {
        continue; // a torn tail line must not lose the rest of the log
      }
      if (record.op === "send") {
        if (!this.messages.some((m) => m.id === record.message.id)) {
          this.messages.push({
            ...record.message,
            deliveries: record.message.deliveries ?? 0,
          });
        }
      } else if (record.op === "ack") {
        const message = this.messages.find((m) => m.id === record.id);
        if (message) message.acked = true;
      }
    }
  }

  private persist(record: LogRecord): void {
    if (!this.file) return;
    const dir = path.dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(record)}\n`, "utf8");
  }

  /**
   * Rewrite the durable log to its current state (one `send` line per message,
   * plus an `ack` line for each acked message). Keeps the log bounded. No-op for
   * an in-memory mailbox.
   */
  compact(): void {
    if (!this.file) return;
    const lines: string[] = [];
    for (const message of this.messages) {
      lines.push(JSON.stringify({ op: "send", message: { ...message } } satisfies LogRecord));
      if (message.acked) {
        lines.push(JSON.stringify({ op: "ack", id: message.id } satisfies LogRecord));
      }
    }
    writeFileSync(this.file, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
  }
}

function matches(
  message: MailboxMessage,
  types?: MailboxMessageType[],
  filter?: MailboxFilter,
): boolean {
  if (types && types.length > 0 && !types.includes(message.type)) return false;
  if (filter?.to !== undefined && message.to !== filter.to) return false;
  if (filter?.from !== undefined && message.from !== filter.from) return false;
  return true;
}

function cloneMessage(message: MailboxMessage): MailboxMessage {
  return { ...message };
}
