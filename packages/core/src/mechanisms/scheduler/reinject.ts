/**
 * M7 — result re-injection.
 *
 * A background / scheduled task finishes *outside* a turn. The agent loop only
 * sees things that are in the session's message array, so the way to make a
 * settled task observable to the model is to append one `ChatMessage` to that
 * array. That is exactly what this module builds:
 *
 * ```ts
 * const messages = store.getMessages(sessionId);
 * reinjectTaskOutcome(messages, outcome);   // push one message
 * store.saveMessages(sessionId, messages);
 * ```
 *
 * This is the same "result re-injection = one message" idea as M5's subagent,
 * except the result arrives asynchronously, so it cannot ride back as a
 * `role:"tool"` message inside a turn; it is appended as the next `role:"user"`
 * message (a system reminder also works — see {@link ReinjectOptions.role}).
 *
 * `taskOutcomeToEvent()` additionally describes how the same settlement would
 * map to an `AgentEvent`. We deliberately do **not** apply it: `AgentEvent` is
 * frozen in `packages/core/src/events.ts`, which M7 must not edit. Adding the
 * variant there is a one-line union change for the integrator (documented in
 * `docs/mechanisms/scheduler.md`); the re-injection path above needs no change
 * to `events.ts` at all.
 */

import type { ChatMessage, SystemMessage, UserMessage } from "../../types.js";
import type { OutcomeStatus, TaskKind, TaskOutcome } from "./types.js";

/** The proposed event type for a settled task. */
export const TASK_SETTLED_EVENT = "task.settled" as const;

/**
 * A proposed member of the `AgentEvent` union. It is shaped like the existing
 * variants (`{ type, ..., at }`) so it can be added to `events.ts` verbatim,
 * but this module never imports or mutates `events.ts`.
 */
export interface ProposedTaskSettledEvent {
  type: typeof TASK_SETTLED_EVENT;
  taskId: string;
  name: string;
  kind: TaskKind;
  status: OutcomeStatus;
  result?: unknown;
  error?: string;
  /** The execution index (0 for a cancel before any run). */
  run: number;
  at: number;
}

export interface ReinjectOptions {
  /**
   * Which role to inject as. `user` (default) is the general "notification the
   * model must react to" channel; `system` is for a quieter reminder.
   */
  role?: "user" | "system";
  /** Clamp the result text. Defaults to 4000 characters. */
  maxResultChars?: number;
  /**
   * Trailing instruction shown for successful results. Defaults to a line
   * telling the model the work ran outside the current turn.
   */
  guidance?: string;
  /** Include the result body for successes. Defaults to `true`. */
  includeResult?: boolean;
}

const DEFAULT_GUIDANCE =
  "This task ran outside the current turn. If the user is waiting on it, " +
  "summarize the result now; otherwise fold it into your next reply.";

/** Render a result value as readable text, clamped to `maxChars`. */
export function stringifyTaskResult(value: unknown, maxChars = 4000): string {
  if (value === undefined) return "(no result)";
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
}

/** Build the re-injection text for an outcome. */
export function formatTaskOutcome(
  outcome: TaskOutcome,
  opts: ReinjectOptions = {},
): string {
  const maxChars = opts.maxResultChars ?? 4000;
  const header =
    `[background task ${outcome.status}] id=${outcome.taskId} ` +
    `name="${outcome.name}" (${outcome.kind}, run ${outcome.run}, ` +
    `${outcome.durationMs}ms)`;

  if (outcome.status === "succeeded") {
    const lines = [header];
    if (opts.includeResult ?? true) {
      lines.push("", "Result:", stringifyTaskResult(outcome.result, maxChars));
    }
    lines.push("", opts.guidance ?? DEFAULT_GUIDANCE);
    return lines.join("\n");
  }
  if (outcome.status === "failed") {
    return [header, "", `Error: ${outcome.error ?? "(unknown error)"}`].join("\n");
  }
  return `${header}\n\nThe task was cancelled before it produced a result.`;
}

/**
 * Turn a settled task into a session message. Appending the returned value to
 * the session's message array is the entire re-injection.
 */
export function taskOutcomeToMessage(
  outcome: TaskOutcome,
  opts: ReinjectOptions = {},
): ChatMessage {
  const content = formatTaskOutcome(outcome, opts);
  if ((opts.role ?? "user") === "system") {
    const message: SystemMessage = { role: "system", content };
    return message;
  }
  const message: UserMessage = { role: "user", content };
  return message;
}

/** Push {@link taskOutcomeToMessage} onto an array; returns the message. */
export function reinjectTaskOutcome(
  messages: ChatMessage[],
  outcome: TaskOutcome,
  opts: ReinjectOptions = {},
): ChatMessage {
  const message = taskOutcomeToMessage(outcome, opts);
  messages.push(message);
  return message;
}

/**
 * The event form of the same settlement. This does not touch `events.ts`; it is
 * the payload an integrator would emit after adding `TASK_SETTLED_EVENT` to the
 * `AgentEvent` union.
 */
export function taskOutcomeToEvent(
  outcome: TaskOutcome,
  at: number = outcome.finishedAt,
): ProposedTaskSettledEvent {
  return {
    type: TASK_SETTLED_EVENT,
    taskId: outcome.taskId,
    name: outcome.name,
    kind: outcome.kind,
    status: outcome.status,
    result: outcome.result,
    error: outcome.error,
    run: outcome.run,
    at,
  };
}
