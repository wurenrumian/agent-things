import type { ChatMessage } from "../../types.js";
import type { CompactOptions, CompactResult } from "./types.js";

/**
 * `compact()` — fold the middle of a conversation into one summary message.
 *
 * Shape of the transformation (system prefix is never touched):
 *
 *     [system…] [leading…] [        middle        ] [recent tail…]
 *                  keepLeading   -> summarize <-      keepRecent
 *
 *     spliced:  [system…] [leading…] [summary] [recent tail…]
 *     leading:  [system…] [summary]  [leading…] [recent tail…]
 *
 * Purity: the input array is never mutated; every message that is not folded or
 * rewritten is shared by reference into the result. The only side effect is the
 * caller-injected `summarize`, which may be a model call.
 */

const DEFAULT_MARKER = "[conversation-summary]";

/** Coerce an option count to a non-negative integer (defensive, 铁律 #4). */
function count(value: number | undefined, fallback = 0): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/**
 * Like {@link compact} but returns the observability payload too (how many
 * messages were folded, where the summary landed, …). `compact()` is the thin
 * array-only wrapper most callers want.
 */
export async function compactDetailed(
  messages: ChatMessage[],
  options: CompactOptions,
): Promise<CompactResult> {
  const { summarize } = options;
  if (typeof summarize !== "function") {
    throw new TypeError("compact: `summarize` must be a function");
  }

  const keepLeading = count(options.keepLeading);
  const keepRecent = count(options.keepRecent);
  const placement = options.placement ?? "spliced";
  const summaryRole = options.summaryRole ?? "user";
  const marker = options.summaryMarker ?? DEFAULT_MARKER;

  // The leading run of system messages is the frozen prefix: always kept.
  // (A single system message is the normal case; a run lets a caller stack
  // additional stable system sections without them being summarized.)
  let sysEnd = 0;
  while (sysEnd < messages.length && messages[sysEnd]!.role === "system") {
    sysEnd++;
  }
  const head = messages.slice(0, sysEnd);
  const body = messages.slice(sysEnd);

  // Split the body into [leading | middle | tail]. Guard every slice so a
  // keepLeading/keepRecent larger than the body never overlaps the middle.
  const leading = body.slice(0, Math.min(keepLeading, body.length));
  const rest = body.slice(leading.length);
  const tailStart = Math.max(0, rest.length - keepRecent);
  const middle = rest.slice(0, tailStart);
  const tail = rest.slice(tailStart);

  if (middle.length === 0) {
    // Nothing to summarize: return a shallow copy so callers still get a new
    // array (and never accidentally mutate the caller's history).
    return {
      messages: messages.slice(),
      summary: "",
      summarized: 0,
      keptLeading: leading.length,
      keptRecent: tail.length,
      summaryIndex: -1,
    };
  }

  const summary = await summarize(middle);
  const text = summary.length > 0 ? `${marker}\n${summary}` : marker;
  const summaryMessage: ChatMessage =
    summaryRole === "system"
      ? { role: "system", content: text }
      : { role: "user", content: text };

  const assembled =
    placement === "leading"
      ? [...head, summaryMessage, ...leading, ...tail]
      : [...head, ...leading, summaryMessage, ...tail];

  return {
    messages: assembled,
    summary,
    summarized: middle.length,
    keptLeading: leading.length,
    keptRecent: tail.length,
    summaryIndex:
      placement === "leading" ? head.length : head.length + leading.length,
  };
}

/**
 * Summarize the middle of `messages` into one summary message, keeping a recent
 * tail verbatim. Returns a new array; the input is never modified.
 */
export async function compact(
  messages: ChatMessage[],
  options: CompactOptions,
): Promise<ChatMessage[]> {
  return (await compactDetailed(messages, options)).messages;
}
