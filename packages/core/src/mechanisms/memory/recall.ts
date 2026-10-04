/**
 * M9 — deterministic recall ranking.
 *
 * The whole point of choosing a *hand-rolled, deterministic* ranker over
 * embeddings is that recall must be reproducible: the same corpus + the same
 * query must always return the same top-K, in the same order. That makes it
 * safe for a coordinator to pre-fetch memories before a model call (see
 * `recall`), and it keeps the rendered block byte-stable so it can live in a
 * cached prefix when desired.
 *
 * Ranking is **keyword overlap + recency**:
 *
 *   score = 1000 * overlap + recencyIndex
 *
 * - `overlap` is the number of distinct query keywords found in the entry's
 *   text or tags (a tag that exactly equals a keyword counts twice, so tags are
 *   a strong signal).
 * - `recencyIndex` is the entry's position in the store's insertion order, so
 *   ties break toward the newest entry. Because the index is bounded by the
 *   corpus size and the overlap term is multiplied by 1000, keyword relevance
 *   always dominates recency — recency is a tiebreaker, not a substitute.
 * - A final `id` comparison makes the order total and fully deterministic.
 *
 * No `import` of the store at runtime (only a type import) so this module can be
 * used standalone by a coordinator on a plain `MemoryEntry[]`.
 */

import type { MemoryEntry } from "./store.js";

/** Very small English stopword list; keeps keyword overlap meaningful. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "at", "for", "with",
  "is", "are", "was", "were", "be", "been", "it", "its", "this", "that",
  "my", "me", "i", "we", "you", "your", "do", "does", "did", "as", "by",
]);

/**
 * Split text into lowercase keyword tokens. Unicode-aware (`\p{L}\p{N}`) so
 * non-ASCII memories still tokenize; drops single characters and stopwords.
 */
export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return matches.filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

/** A corpus source: either a `MemoryStore`-like object or an explicit array. */
export interface MemoryCorpus {
  all(): MemoryEntry[];
}

export interface RecallOptions {
  /** Maximum entries to return (default 5). */
  limit?: number;
  /** Explicit corpus. Takes precedence over `store`. */
  entries?: MemoryEntry[];
  /** Corpus source when `entries` is not given. */
  store?: MemoryCorpus;
  /**
   * Minimum overlap for a keyword query (default 1). Ignored when the query
   * yields no keywords, in which case the most recent entries are returned.
   */
  minOverlap?: number;
}

/** Normalize a possibly-undefined limit to a positive integer. */
function normalizeLimit(limit: number | undefined, size: number): number {
  if (limit === undefined) return Math.min(5, size);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(Math.floor(limit), size);
}

/** Count how many distinct query keywords appear in one entry. */
function overlapScore(entry: MemoryEntry, keywords: string[]): number {
  const tags = (entry.tags ?? []).map((tag) => tag.toLowerCase());
  const haystack = `${entry.text} ${tags.join(" ")}`.toLowerCase();
  let overlap = 0;
  for (const keyword of keywords) {
    if (haystack.includes(keyword)) overlap += 1;
    if (tags.includes(keyword)) overlap += 1; // exact tag match is a strong signal
  }
  return overlap;
}

/**
 * Rank `entries` for `query` and return the top-K. Pure and deterministic:
 * no clock, no randomness, no I/O.
 */
export function rankEntries(
  entries: MemoryEntry[],
  query: string,
  options: Pick<RecallOptions, "limit" | "minOverlap"> = {},
): MemoryEntry[] {
  const size = entries.length;
  const limit = normalizeLimit(options.limit, size);
  if (size === 0 || limit === 0) return [];

  const keywords = [...new Set(tokenize(query))];
  const indexed = entries.map((entry, index) => ({ entry, index }));

  // No usable keywords → most-recent-first, still fully deterministic.
  if (keywords.length === 0) {
    return indexed
      .sort((a, b) => b.index - a.index || a.entry.id.localeCompare(b.entry.id))
      .slice(0, limit)
      .map((item) => item.entry);
  }

  const minOverlap = options.minOverlap ?? 1;
  const scored = indexed
    .map(({ entry, index }) => ({
      entry,
      overlap: overlapScore(entry, keywords),
      score: overlapScore(entry, keywords) * 1000 + index,
    }))
    .filter((item) => item.overlap >= minOverlap);

  scored.sort(
    (a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id),
  );
  return scored.slice(0, limit).map((item) => item.entry);
}

/**
 * Return the top-K entries for `query` using the same deterministic ranking as
 * `MemoryStore.search`. This is the "coordinator pre-fetch" entry point: a
 * caller can pull memories into a prompt without asking the model to call the
 * `memory` tool first.
 *
 * ```ts
 * const hits = recall("cache injection point", { store, limit: 3 });
 * ```
 */
export function recall(query: string, options: RecallOptions = {}): MemoryEntry[] {
  const entries = options.entries ?? options.store?.all() ?? [];
  return rankEntries(entries, query, options);
}
