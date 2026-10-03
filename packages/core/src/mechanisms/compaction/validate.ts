import type { ChatMessage } from "../../types.js";

/**
 * Structural checks for an OpenAI/OpenRouter-style tool transcript.
 *
 * Both reclamation primitives must leave a *valid* transcript: `compact()`
 * removes whole assistant/tool pairs atomically, and `clearToolResults()` only
 * rewrites bodies. This validator is how the experiment (and any caller that
 * wants a guard) proves that invariant instead of assuming it.
 */

/**
 * Return a list of structural problems that would make a tool transcript
 * invalid. Empty list means valid.
 */
export function validateToolTranscript(messages: ChatMessage[]): string[] {
  const problems: string[] = [];

  /** tool_call id -> index of the assistant message that declared it. */
  const pending = new Map<string, number>();
  const seen = new Set<string>();

  messages.forEach((message, index) => {
    if (message.role === "assistant") {
      for (const call of message.tool_calls ?? []) {
        if (pending.has(call.id)) {
          problems.push(`duplicate tool_call id "${call.id}" at index ${index}`);
        }
        pending.set(call.id, index);
        seen.add(call.id);
      }
      return;
    }
    if (message.role !== "tool") return;

    if (!seen.has(message.tool_call_id)) {
      problems.push(
        `tool message at index ${index} references unknown tool_call_id ` +
          `"${message.tool_call_id}"`,
      );
      return;
    }
    if (!pending.has(message.tool_call_id)) {
      problems.push(
        `tool message at index ${index} duplicates tool_call_id ` +
          `"${message.tool_call_id}"`,
      );
      return;
    }
    pending.delete(message.tool_call_id);
  });

  for (const [id, index] of pending) {
    problems.push(
      `assistant tool_call "${id}" at index ${index} has no tool result`,
    );
  }
  return problems;
}

/** Convenience boolean wrapper around {@link validateToolTranscript}. */
export function isToolTranscriptValid(messages: ChatMessage[]): boolean {
  return validateToolTranscript(messages).length === 0;
}
