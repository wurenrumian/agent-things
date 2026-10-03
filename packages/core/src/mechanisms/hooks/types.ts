/**
 * Hook system types (M6, L4 in MECHANISMS.md).
 *
 * A *hook* is a small, ordered policy callback attached to a lifecycle point of
 * the agent loop. Unlike a permission rule (which only says yes/no to a tool),
 * a hook can also **rewrite its subject** — the tool input for `preToolUse`, or
 * the text for `userPromptSubmit` / `preCompact`.
 *
 * The four lifecycle points this module speaks:
 *
 *   preToolUse        — before a tool executes; may allow / ask / deny / mutate
 *   postToolUse       — after a tool returns; observational (audit, redact)
 *   preCompact        — before history is compacted; may inject instructions
 *   userPromptSubmit  — before a user prompt enters the model; may rewrite it
 *
 * Matched either by exact tool name (`match.tool`), by regex (`match.toolRegex`),
 * and/or by a regex over the serialized arguments (`match.argPattern`).
 */

/** Lifecycle points a hook can subscribe to. */
export type HookEvent =
  | "preToolUse"
  | "postToolUse"
  | "preCompact"
  | "userPromptSubmit";

/** Canonical list, handy for validation and docs. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  "preToolUse",
  "postToolUse",
  "preCompact",
  "userPromptSubmit",
];

/** How a hook selects the calls it cares about. All fields are ANDed. */
export interface HookMatch {
  /** Exact tool name, or `"*"` for any tool. */
  tool?: string;
  /** Regex source tested against the tool name. */
  toolRegex?: string;
  /**
   * Regex source tested against the subject: `JSON.stringify(input)` for tool
   * events, or the raw text for prompt/compact events.
   */
  argPattern?: string;
}

/**
 * What a hook returns.
 *
 * `allow` / `ask` / `deny` are verdicts; `mutate` rewrites the subject and (by
 * itself) leaves the verdict to the rule layer. A hook may return `undefined`
 * to mean "not applicable, leave me out of the decision".
 */
export type HookOutcome =
  | { kind: "allow"; reason?: string; note?: string }
  | { kind: "deny"; reason: string; note?: string }
  | { kind: "ask"; reason: string; note?: string }
  | {
      kind: "mutate";
      reason?: string;
      note?: string;
      /** Replacement tool input (preToolUse). */
      input?: Record<string, unknown>;
      /** Replacement text (userPromptSubmit / preCompact). */
      text?: string;
    };

/** The subject a hook runs against. */
export interface HookContext {
  event: HookEvent;
  /** Present for tool events. */
  tool?: string;
  /** Present for tool events. */
  input?: Record<string, unknown>;
  /** Present for text events. */
  text?: string;
  /** Optional turn grouping, carried through untouched. */
  turnId?: string;
}

/** A hook's executable body. */
export type HookHandler = (
  ctx: HookContext,
) => HookOutcome | undefined | Promise<HookOutcome | undefined>;

/** One registered hook. */
export interface HookDef {
  /** Stable id used in traces and decisions. */
  id: string;
  events: HookEvent[];
  match?: HookMatch;
  handler: HookHandler;
}

/** A hook that fired, with its outcome — the audit record. */
export interface HookOutcomeRecord {
  hookId: string;
  event: HookEvent;
  outcome: HookOutcome;
}

/** Result of running one event: the records plus the possibly-mutated subject. */
export interface HookRunResult {
  event: HookEvent;
  records: HookOutcomeRecord[];
  input?: Record<string, unknown>;
  text?: string;
}
