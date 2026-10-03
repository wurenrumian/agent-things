import type { ChatMessage } from "../../types.js";

/**
 * M3 — compaction & context reclamation: shared types.
 *
 * Everything here is a *pure transformation over a message array*. The
 * mechanism never owns state and never touches the agent loop; callers pass an
 * array in and get a new array out. That is deliberate (mechanisms/ 铁律 #1 &
 * #4): reclamation is a policy the loop can apply between steps, not a change
 * to the loop itself.
 */

/**
 * The injected summarizer. Returning a string (or a promise of one) lets the
 * exact same `compact()` primitive run with a deterministic stub in tests or a
 * real model call in production — the primitive does not care which.
 */
export type SummaryFn = (messages: ChatMessage[]) => string | Promise<string>;

/**
 * Where the synthesized summary message lands relative to the retained
 * history.
 *
 * - `"spliced"` (default): the summary replaces the summarized span *in place*
 *   — it sits after any retained leading messages and before the recent tail.
 *   This keeps the largest shared prefix with the pre-compaction request.
 * - `"leading"`: the summary is pinned to a *fixed* slot immediately after the
 *   system prefix (before any retained messages). Its position never depends on
 *   where the summarized span began.
 */
export type SummaryPlacement = "spliced" | "leading";

export interface CompactOptions {
  /** How many of the most recent messages to keep verbatim (the tail). */
  keepRecent: number;
  /** The injected summarizer for the folded middle. */
  summarize: SummaryFn;
  /**
   * How many leading non-system messages to keep verbatim before the
   * summarized span (e.g. the original task statement). Defaults to 0.
   */
  keepLeading?: number;
  /** Summary placement. Defaults to `"spliced"`. */
  placement?: SummaryPlacement;
  /** Role of the synthesized summary message. Defaults to `"user"`. */
  summaryRole?: "user" | "system";
  /** Marker prepended to the summary text so it is findable in a transcript. */
  summaryMarker?: string;
}

/** The full result of a compaction, including observability numbers. */
export interface CompactResult {
  /** The new message array. Never the input array. */
  messages: ChatMessage[];
  /** The raw summary text returned by the injected `summarize`. */
  summary: string;
  /** How many messages were folded into the summary (0 when nothing to do). */
  summarized: number;
  /** How many leading non-system messages were kept verbatim. */
  keptLeading: number;
  /** How many recent messages were kept verbatim. */
  keptRecent: number;
  /** Index of the summary message in `messages`, or -1 when none was added. */
  summaryIndex: number;
}

export interface ClearToolResultsOptions {
  /** Keep the content of the N most recent `role:"tool"` messages. */
  keepLastN: number;
  /** Replacement content for cleared tool messages. */
  placeholder?: string;
}

/** The full result of clearing tool results, including observability numbers. */
export interface ClearToolResultsResult {
  /** The new message array. Never the input array. */
  messages: ChatMessage[];
  /** Number of tool messages whose content was replaced. */
  cleared: number;
  /** Number of tool messages left untouched. */
  kept: number;
  /** Characters of tool-result content reclaimed. */
  charsSaved: number;
  /** Coarse estimate of tokens reclaimed (display heuristic; real = `usage`). */
  estimatedTokensSaved: number;
}
