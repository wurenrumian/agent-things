/**
 * M9 — rendering memories into context.
 *
 * This is the *injection half* of memory, and it is where the lesson lives:
 * **a memory is just characters placed into the message array at the right
 * time — and the injection point decides whether it breaks the prompt cache.**
 *
 * The same rendered block can be placed in two structurally different spots:
 *
 * 1. `memorySystemSuffix(entries)` — text meant to be *appended to the end of*
 *    the system prompt. Appending to the end of an already-cached prefix is an
 *    append-only edit, so it does not invalidate the prefix (M2 §c′). Splicing
 *    the same block into the *middle* of the system prompt does: every later
 *    byte shifts and the provider re-creates the prefix from that point.
 * 2. `memoryTailMessage(entries)` — a fresh `user` message appended at the tail
 *    of the history. This is the safe default: the cached prefix (system +
 *    tools + earlier turns) stays byte-identical; only the new tail is uncached.
 *
 * Both return the same `renderMemories` string, so the experiment can attribute
 * any `cached_tokens` difference to *position*, not content.
 *
 * Rendering is stable by construction: entries are emitted in the order given
 * (the store's insertion order), no clock is read, and the only timestamp is
 * the entry's own immutable `createdAt`. Identical entries always produce an
 * identical block, which is what lets a fixed memory block itself become part
 * of a cached prefix.
 */

import type { ChatMessage } from "../../types.js";
import type { MemoryEntry } from "./store.js";

/** Markers let a model (and a reader) see exactly where memory starts/ends. */
export const MEMORY_OPEN = "<memories>";
export const MEMORY_CLOSE = "</memories>";

export interface RenderOptions {
  /** Render at most this many entries (default: all of them). */
  limit?: number;
  /** Wrap in `<memories>...</memories>` (default true). */
  header?: boolean;
  /** Include each entry's ISO `createdAt` (default true). */
  includeTimestamps?: boolean;
}

/**
 * Format entries into one stable text block:
 *
 * ```text
 * <memories>
 * - [mem_abc] saved=2026-10-04T00:00:00.000Z tags=cache,memory text here
 * </memories>
 * ```
 *
 * An empty list yields the empty block `"<memories>\n(none)\n</memories>"` (or
 * `""` when `header: false`) rather than a special case at every call site.
 */
export function renderMemories(
  entries: MemoryEntry[],
  options: RenderOptions = {},
): string {
  const list =
    options.limit !== undefined ? entries.slice(0, Math.max(0, options.limit)) : entries;
  const header = options.header !== false;
  const includeTimestamps = options.includeTimestamps !== false;

  if (list.length === 0) {
    return header ? `${MEMORY_OPEN}\n(none)\n${MEMORY_CLOSE}` : "";
  }

  const lines = list.map((entry) => {
    const parts = [`- [${entry.id}]`];
    if (includeTimestamps) {
      parts.push(`saved=${new Date(entry.createdAt).toISOString()}`);
    }
    if (entry.tags && entry.tags.length > 0) {
      parts.push(`tags=${entry.tags.join(",")}`);
    }
    parts.push(entry.text);
    return parts.join(" ");
  });

  return header ? [MEMORY_OPEN, ...lines, MEMORY_CLOSE].join("\n") : lines.join("\n");
}

/**
 * A memory block shaped for the **system prompt**, prefixed with a blank-line
 * separator. Append this to the *end* of an existing system prompt to keep the
 * cached prefix intact; inserting it earlier is a rewrite and will miss.
 */
export function memorySystemSuffix(
  entries: MemoryEntry[],
  options: RenderOptions = {},
): string {
  const block = renderMemories(entries, options);
  return block === "" ? "" : `\n\n${block}`;
}

/**
 * A memory block shaped as a **tail message** to append to the history. Returns
 * a plain `user` message; tool results are the other safe tail slot (see
 * `createMemoryTool`, whose output is exactly `renderMemories(...)`).
 */
export function memoryTailMessage(
  entries: MemoryEntry[],
  options: RenderOptions = {},
): ChatMessage {
  return { role: "user", content: renderMemories(entries, options) };
}
