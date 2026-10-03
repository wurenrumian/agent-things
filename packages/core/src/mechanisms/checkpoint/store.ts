/**
 * `CheckpointStore` — per-turn, byte-exact file snapshots (M6, L6 in
 * MECHANISMS.md).
 *
 * The point of the mechanism: **code rollback is not conversation rollback.**
 * This store knows nothing about messages, turns-as-dialogue, or the model. It
 * only remembers the *bytes* of files before a turn mutates them, grouped by a
 * caller-supplied turn id, and can put those bytes back exactly.
 *
 * Snapshot semantics:
 *   - First snapshot of a path within a turn wins (the state "before this turn").
 *   - A path that did not exist when snapshotted is remembered as *absent*;
 *     restoring it deletes the file if a later write created it.
 *   - Restore is verified by sha256, and a file is only "identical" when the
 *     hash on disk equals the snapshot hash (an absent file has the empty hash).
 *
 * Storage is always in memory; pass a directory to `CheckpointStore.open(dir)`
 * to additionally mirror the snapshots to `<dir>/checkpoints.json` (base64) so
 * they survive the process.
 *
 * Self-contained: only `node:fs` / `node:path` / `node:crypto` / `node:buffer`.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** sha256 hex digest of a byte buffer. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** One remembered file state. */
export interface Snapshot {
  turnId: string;
  /** Absolute, normalized path of the file. */
  path: string;
  /** Whether the file existed when snapshotted. */
  existed: boolean;
  /** Original bytes (empty when the file was absent). */
  bytes: Uint8Array;
  /** sha256 of `bytes`; `""` for an absent file. */
  hash: string;
  size: number;
  at: number;
}

export type RestoreAction = "restore" | "delete" | "missing";

/** Per-file result of a restore. */
export interface RestoreEntry {
  path: string;
  action: RestoreAction;
  /** Hash of the file before the restore (`""` if it was absent). */
  beforeHash: string;
  /** Hash after the restore (`""` if the file is now absent). */
  afterHash: string;
  /** True iff `afterHash ===` the snapshot hash. */
  identical: boolean;
}

export interface RestoreReport {
  turnId: string;
  entries: RestoreEntry[];
  /** True iff every snapshot in the turn is byte-identical afterwards. */
  identical: boolean;
  restored: number;
  deleted: number;
}

/** Per-file result of a read-only verification. */
export interface VerifyEntry {
  path: string;
  exists: boolean;
  expectedHash: string;
  actualHash: string;
  identical: boolean;
}

export interface VerifyReport {
  turnId: string;
  entries: VerifyEntry[];
  identical: boolean;
}

export interface CheckpointOptions {
  /** Optional persistence directory (absolute). */
  dir?: string;
}

interface SerializedSnapshot {
  path: string;
  existed: boolean;
  hash: string;
  size: number;
  at: number;
  /** base64 of `bytes`. */
  bytes: string;
}

interface SerializedTurn {
  turnId: string;
  snapshots: SerializedSnapshot[];
}

interface SerializedStore {
  version: 1;
  turns: SerializedTurn[];
}

const STORE_FILE = "checkpoints.json";

interface ReadResult {
  exists: boolean;
  bytes: Uint8Array;
  hash: string;
}

export class CheckpointStore {
  private readonly turns = new Map<string, Map<string, Snapshot>>();
  private readonly dir?: string;
  private turnSeq = 0;
  private current?: string;

  private constructor(options: CheckpointOptions) {
    this.dir = options.dir ? path.resolve(options.dir) : undefined;
  }

  /** A store that lives only in this process. */
  static inMemory(): CheckpointStore {
    return new CheckpointStore({});
  }

  /** A store mirrored to `<dir>/checkpoints.json`; loads any existing file. */
  static async open(dir: string): Promise<CheckpointStore> {
    const store = new CheckpointStore({ dir });
    await mkdir(store.dir!, { recursive: true });
    await store.load();
    return store;
  }

  /** Persistence directory, if any. */
  storeDir(): string | undefined {
    return this.dir;
  }

  /** Start (or resume) a turn and make it current. Returns its id. */
  beginTurn(turnId?: string): string {
    const id = turnId ?? `turn-${++this.turnSeq}`;
    if (!this.turns.has(id)) this.turns.set(id, new Map());
    this.current = id;
    return id;
  }

  /** The turn new snapshots go to, if one has been started. */
  currentTurn(): string | undefined {
    return this.current;
  }

  /** Turn ids in first-seen order. */
  listTurns(): string[] {
    return [...this.turns.keys()];
  }

  /** Snapshots in one turn, in first-snapshot order. */
  list(turnId: string): Snapshot[] {
    return [...(this.turns.get(turnId)?.values() ?? [])];
  }

  /** One snapshot, or `undefined`. */
  get(turnId: string, filePath: string): Snapshot | undefined {
    return this.turns.get(turnId)?.get(path.resolve(filePath));
  }

  /**
   * Remember `filePath`'s current bytes before it is mutated. First snapshot in
   * a turn wins; later calls for the same path return the original snapshot.
   */
  async snapshot(filePath: string, turnId?: string): Promise<Snapshot> {
    const turn = turnId ?? this.current ?? this.beginTurn();
    const map = this.#turn(turn);
    const abs = path.resolve(filePath);
    const existing = map.get(abs);
    if (existing) return existing;

    const state = await this.#read(abs);
    const snap: Snapshot = {
      turnId: turn,
      path: abs,
      existed: state.exists,
      bytes: state.bytes,
      hash: state.hash,
      size: state.bytes.length,
      at: Date.now(),
    };
    map.set(abs, snap);
    await this.persist();
    return snap;
  }

  /** Snapshot several paths into one turn. */
  async snapshotMany(files: string[], turnId?: string): Promise<Snapshot[]> {
    const turn = turnId ?? this.current ?? this.beginTurn();
    const out: Snapshot[] = [];
    for (const file of files) out.push(await this.snapshot(file, turn));
    return out;
  }

  /** Restore every file snapshotted in `turnId`, byte-for-byte. */
  async restoreTurn(turnId: string): Promise<RestoreReport> {
    const map = this.turns.get(turnId);
    if (!map) throw new Error(`checkpoint: unknown turn "${turnId}"`);
    const entries: RestoreEntry[] = [];
    for (const snap of map.values()) {
      entries.push(await this.#restore(snap));
    }
    return {
      turnId,
      entries,
      identical: entries.every((entry) => entry.identical),
      restored: entries.filter((entry) => entry.action === "restore").length,
      deleted: entries.filter((entry) => entry.action === "delete").length,
    };
  }

  /** Restore a single snapshotted file from `turnId`. */
  async restoreFile(turnId: string, filePath: string): Promise<RestoreEntry> {
    const snap = this.get(turnId, filePath);
    if (!snap) {
      throw new Error(`checkpoint: turn "${turnId}" has no snapshot for ${filePath}`);
    }
    return this.#restore(snap);
  }

  /** Read-only: does disk still match the snapshots of `turnId`? */
  async verify(turnId: string): Promise<VerifyReport> {
    const map = this.turns.get(turnId);
    if (!map) throw new Error(`checkpoint: unknown turn "${turnId}"`);
    const entries: VerifyEntry[] = [];
    for (const snap of map.values()) {
      const state = await this.#read(snap.path);
      entries.push({
        path: snap.path,
        exists: state.exists,
        expectedHash: snap.hash,
        actualHash: state.hash,
        identical: state.hash === snap.hash,
      });
    }
    return { turnId, entries, identical: entries.every((entry) => entry.identical) };
  }

  /** Mirror all snapshots to disk, when a directory was configured. */
  async persist(): Promise<void> {
    if (!this.dir) return;
    const payload: SerializedStore = {
      version: 1,
      turns: [...this.turns.entries()].map(([turnId, map]) => ({
        turnId,
        snapshots: [...map.values()].map((snap) => ({
          path: snap.path,
          existed: snap.existed,
          hash: snap.hash,
          size: snap.size,
          at: snap.at,
          bytes: Buffer.from(snap.bytes).toString("base64"),
        })),
      })),
    };
    await writeFile(path.join(this.dir, STORE_FILE), JSON.stringify(payload), "utf8");
  }

  /** Load snapshots from `<dir>/checkpoints.json`, if present. */
  private async load(): Promise<void> {
    if (!this.dir) return;
    const file = path.join(this.dir, STORE_FILE);
    if (!existsSync(file)) return;
    const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (
      typeof raw !== "object" ||
      raw === null ||
      !Array.isArray((raw as SerializedStore).turns)
    ) {
      throw new Error(`checkpoint: malformed store file ${file}`);
    }
    for (const turn of (raw as SerializedStore).turns) {
      const map = this.#turn(turn.turnId);
      for (const snap of turn.snapshots) {
        const bytes = new Uint8Array(Buffer.from(snap.bytes, "base64"));
        map.set(path.resolve(snap.path), {
          turnId: turn.turnId,
          path: path.resolve(snap.path),
          existed: snap.existed,
          bytes,
          hash: snap.hash,
          size: snap.size,
          at: snap.at,
        });
      }
    }
  }

  async #restore(snap: Snapshot): Promise<RestoreEntry> {
    const before = await this.#read(snap.path);
    let action: RestoreAction;

    if (snap.existed) {
      await mkdir(path.dirname(snap.path), { recursive: true });
      await writeFile(snap.path, snap.bytes);
      action = "restore";
    } else if (before.exists) {
      await rm(snap.path);
      action = "delete";
    } else {
      action = "missing";
    }

    const after = await this.#read(snap.path);
    return {
      path: snap.path,
      action,
      beforeHash: before.hash,
      afterHash: after.hash,
      identical: after.hash === snap.hash,
    };
  }

  #turn(turnId: string): Map<string, Snapshot> {
    let map = this.turns.get(turnId);
    if (!map) {
      map = new Map();
      this.turns.set(turnId, map);
    }
    return map;
  }

  async #read(file: string): Promise<ReadResult> {
    try {
      const bytes = await readFile(file);
      return { exists: true, bytes, hash: sha256(bytes) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { exists: false, bytes: new Uint8Array(0), hash: "" };
      }
      throw err;
    }
  }
}
