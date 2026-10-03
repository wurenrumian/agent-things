import { estimateTokens } from "../../content.js";
import type { ChatMessage } from "../../types.js";
import type {
  ClearToolResultsOptions,
  ClearToolResultsResult,
} from "./types.js";

/**
 * `clearToolResults()` — reclaim context by emptying the *content* of old tool
 * results while keeping every `tool_call_id` intact.
 *
 * Why the structure matters: an OpenAI/OpenRouter transcript is only valid if
 * every `assistant.tool_calls[].id` has a matching `role:"tool"` message. So we
 * can never delete a tool message to save space — we replace its body and keep
 * the envelope. The model still sees that the call happened and can decide to
 * re-run it; it just no longer pays for the (usually bulky, usually stale)
 * output.
 *
 * Purity: returns a new array; untouched messages are shared by reference.
 */

/** Default replacement content for a cleared tool result. */
export const CLEARED_TOOL_RESULT =
  "[cleared: tool result removed to reclaim context]";

/**
 * Like {@link clearToolResults} but also reports how much was reclaimed.
 */
export function clearToolResultsDetailed(
  messages: ChatMessage[],
  options: ClearToolResultsOptions,
): ClearToolResultsResult {
  const keep = Math.max(0, Math.floor(options.keepLastN ?? 0));
  const placeholder = options.placeholder ?? CLEARED_TOOL_RESULT;

  // Indices of tool messages, oldest first. "Keep the last N" is defined over
  // this ordered list, which is robust to interleaved non-tool messages.
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "tool") toolIndices.push(i);
  }

  const clearCount = Math.max(0, toolIndices.length - keep);
  const toClear = new Set(toolIndices.slice(0, clearCount));

  let charsSaved = 0;
  let estimatedTokensSaved = 0;

  const out = messages.map((message, index) => {
    if (message.role !== "tool" || !toClear.has(index)) return message;
    const before = message.content;
    charsSaved += Math.max(0, before.length - placeholder.length);
    estimatedTokensSaved += Math.max(
      0,
      estimateTokens(before) - estimateTokens(placeholder),
    );
    // Keep the envelope (`role`, `tool_call_id`); replace only the body.
    return { ...message, content: placeholder };
  });

  return {
    messages: out,
    cleared: toClear.size,
    kept: toolIndices.length - toClear.size,
    charsSaved,
    estimatedTokensSaved,
  };
}

/**
 * Replace the content of old `role:"tool"` messages with a short placeholder,
 * keeping the tool-call structure valid. Keeps the last `keepLastN` tool
 * results verbatim. Returns a new array.
 */
export function clearToolResults(
  messages: ChatMessage[],
  options: ClearToolResultsOptions,
): ChatMessage[] {
  return clearToolResultsDetailed(messages, options).messages;
}
