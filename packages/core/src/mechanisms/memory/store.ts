/**
 * M9 — `MemoryStore`: append-only, hand-rolled persistence for agent memories.
 *
 * Teaching point: a "memory" is not a database feature — it is a durable list
 * of facts that later gets *injected into context at the right time*. This
 * module owns only the durable half (the list); `render.ts` owns the injection
 * half and `recall.ts` owns deterministic retrieval.
 *
 * Persistence is a single newline-delimited JSON (NDJSON) file. The file is
 * **append-only**: `save` appends a `save` record, `forget` appends a `forget`
 * tombstone. Nothing is ever rewritten in place, so the log is crash-safe (a
 * torn final line is skipped on replay) and human-inspectable. `open()` replays
 * the log to rebuild the in-memory index.
 *
 * This module is self-contained (mechanisms/ 铁律 #1): `node:fs`/`node:path`
 * only, no dependency, and it imports the kernel through relative paths.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { rankEntries } from "./recall.js";

/** One remembered fact. Matches the M9 brief's shape exactly. */
export interface MemoryEntry {
  /** Stable id, unique within the store. */
  id: string;
  /** The fact text. */
  text: string;
  /** Optional free-form labels; also matched by `search`. */
  tags?: string[];
  /** Epoch milliseconds when the entry was created. */
  createdAt: number;
  /** Epoch milliseconds of the last update (absent when never updated). */
  updatedAt?: number;
}

/**
 * One line of the append-only log. Each record is self-describing, so a reader
 * can replay the whole history without any side file.
 */
export type MemoryRecord =
  | { op: "save"; entry: MemoryEntry }
  | { op: "forget"; id: string; at: number };

/** Tunables for opening a store. */
export interface MemoryStoreOptions {
  /** Log file name inside the directory (default `memories.ndjson`). */
  file?: string;
  /** Injectable clock, for deterministic tests (default `Date.now`). */
  now?: () => number;
}

/** Default log file name. Also the fixture name used in the M9 experiment. */
export const MEMORY_FILE = "memories.ndjson";

/** Turn arbitrary tag input into a clean, de-duplicated, non-empty list. */
function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags || tags.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = String(raw).trim();
    if (tag === "" || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * A durable, append-only list of memories.
 *
 * ```ts
 * const store = await MemoryStore.open("./data/memory");
 * await store.save("The build uses pnpm.", ["build"]);
 * store.search("build");        // top hits, deterministic
 * await store.forget(entry.id);
 * ```
 */
export class MemoryStore {
  private readonly dirPath: string;
  private readonly logPath: string;
  private readonly now: () => number;

  /** Insertion-ordered ids; `all()` follows this order. */
  private readonly order: string[] = [];
  private readonly byId = new Map<string, MemoryEntry>();
  /** Disambiguates ids created in the same millisecond. */
  private counter = 0;

  private constructor(dirPath: string, file: string, now: () => number) {
    this.dirPath = dirPath;
    this.logPath = path.join(dirPath, file);
    this.now = now;
  }

  /**
   * Open (or create) a store rooted at `dir`. Creates the directory if needed
   * and replays any existing log. Never throws on a missing/empty log.
   */
  static async open(
    dir: string,
    options: MemoryStoreOptions = {},
  ): Promise<MemoryStore> {
    const store = new MemoryStore(
      path.resolve(dir),
      options.file ?? MEMORY_FILE,
      options.now ?? Date.now,
    );
    await mkdir(store.dirPath, { recursive: true });
    await store.replay();
    return store;
  }

  /** Absolute directory that holds the log. */
  dir(): string {
    return this.dirPath;
  }

  /** Absolute path to the NDJSON log file. */
  file(): string {
    return this.logPath;
  }

  /** Number of live entries (forgotten ones excluded). */
  size(): number {
    return this.byId.size;
  }

  /** All live entries, oldest first (insertion order). Returns copies. */
  all(): MemoryEntry[] {
    return this.order
      .map((id) => this.byId.get(id))
      .filter((entry): entry is MemoryEntry => entry !== undefined)
      .map((entry) => ({ ...entry }));
  }

  /** A copy of one entry, or `undefined`. */
  get(id: string): MemoryEntry | undefined {
    const entry = this.byId.get(id);
    return entry ? { ...entry } : undefined;
  }

  /**
   * Append a new entry. `tags` are normalized (trimmed, de-duplicated, empties
   * dropped). Returns the stored entry.
   */
  async save(text: string, tags?: string[]): Promise<MemoryEntry> {
    const clean = text.trim();
    if (clean === "") throw new Error("memory text must be non-empty");

    const at = this.now();
    const entry: MemoryEntry = {
      id: this.nextId(at),
      text: clean,
      createdAt: at,
    };
    const cleanTags = normalizeTags(tags);
    if (cleanTags.length > 0) entry.tags = cleanTags;

    this.apply({ op: "save", entry });
    await this.append({ op: "save", entry });
    return { ...entry };
  }

  /**
   * Forget one entry by id. Appends a tombstone and returns whether the id was
   * live. Forgetting an unknown id is a no-op (and is *not* written to the log).
   */
  async forget(id: string): Promise<boolean> {
    if (!this.byId.has(id)) return false;
    const at = this.now();
    this.apply({ op: "forget", id, at });
    await this.append({ op: "forget", id, at });
    return true;
  }

  /**
   * Deterministic top-K search: keyword overlap over text + tags, recency as
   * the tiebreaker. Delegates to {@link rankEntries} so a coordinator can run
   * the exact same ranking offline via `recall`.
   */
  search(query: string, limit = 5): MemoryEntry[] {
    return rankEntries(this.all(), query, { limit });
  }

  /* ------------------------------------------------------------ internals */

  /**
   * `mem_<time36>_<counter36>_<rand>` — collision-resistant without a
   * dependency. The counter alone is not enough across two stores opened in the
   * same millisecond, hence the random tail.
   */
  private nextId(at: number): string {
    this.counter += 1;
    const rand = Math.random().toString(36).slice(2, 8);
    return `mem_${at.toString(36)}_${this.counter.toString(36)}_${rand}`;
  }

  private async append(record: MemoryRecord): Promise<void> {
    await appendFile(this.logPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  /** Read the log and apply every well-formed record. Missing file is fine. */
  private async replay(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.logPath, "utf8");
    } catch {
      return;
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let record: MemoryRecord;
      try {
        record = JSON.parse(trimmed) as MemoryRecord;
      } catch {
        continue; // torn / partial trailing line: skip
      }
      this.apply(record);
    }
  }

  /** Apply one record to the in-memory index (idempotent enough for replay). */
  private apply(record: MemoryRecord): void {
    if (record.op === "save") {
      const entry = record.entry;
      if (!entry || typeof entry.id !== "string") return;
      if (!this.byId.has(entry.id)) this.order.push(entry.id);
      this.byId.set(entry.id, { ...entry });
    } else if (record.op === "forget") {
      this.byId.delete(record.id);
      const index = this.order.indexOf(record.id);
      if (index >= 0) this.order.splice(index, 1);
    }
  }
}
