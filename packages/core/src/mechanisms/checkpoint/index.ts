/**
 * M6 — checkpoint mechanism (L6 in MECHANISMS.md).
 *
 * `CheckpointStore` snapshots file bytes per turn and restores them
 * byte-for-byte, independent of conversation history. See `store.ts`.
 */

export * from "./store.js";
