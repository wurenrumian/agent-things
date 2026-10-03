/**
 * `decide()` — combine the ordered rule policy with hooks into one verdict.
 *
 * Semantics (documented; see docs/mechanisms/permissions.md):
 *
 *   1. The rule policy supplies a **base verdict** (first rule that matches, or
 *      a safe default of `ask` when nothing matches).
 *   2. Matching `preToolUse` hooks then run in registration order. Each may
 *      **mutate** the tool input (mutations chain) and/or return an explicit
 *      verdict that **overrides** the base. The last explicit verdict wins.
 *   3. A `deny` is terminal: once a hook denies, nothing after it runs and no
 *      later verdict can lift it.
 *
 * `ask` is returned as `pending: true` — a decision a UI may resolve later. This
 * function never opens an interactive prompt and never calls a model.
 */

import type { Policy, PermissionVerdict } from "./policy.js";
import type { HookRunner } from "./runner.js";

/** A tool call about to be gated. */
export interface ToolRequest {
  tool: string;
  input: Record<string, unknown>;
  turnId?: string;
}

/** Where the final verdict came from. */
export type DecisionSource = "rule" | "hook" | "default";

/** The combined verdict plus everything that contributed. */
export interface Decision {
  kind: PermissionVerdict;
  /** True when `kind === "ask"`: waiting on a UI, not an interactive prompt. */
  pending: boolean;
  reason: string;
  source: DecisionSource;
  /** Contributing rule id, when one matched. */
  ruleId?: string;
  /** Contributing hook id, when a hook decided. */
  hookId?: string;
  /** The tool input after any hook mutations. */
  input: Record<string, unknown>;
  /** True when hooks changed the input. */
  mutated: boolean;
  /** Ordered, human-readable account of what happened. */
  trace: string[];
}

const DEFAULT_VERDICT: PermissionVerdict = "ask";

/**
 * Gate one tool call. Returns the verdict, the reason, the contributing
 * rule/hook id, the (possibly mutated) input, and a trace.
 */
export async function decide(
  policy: Policy,
  hooks: HookRunner,
  request: ToolRequest,
): Promise<Decision> {
  const original = { ...request.input };
  const trace: string[] = [];

  const rule = policy.match({ tool: request.tool, input: original });
  let kind: PermissionVerdict = rule?.decision ?? DEFAULT_VERDICT;
  let reason: string = rule?.reason ?? "no rule matched; default ask";
  let source: DecisionSource = rule ? "rule" : "default";
  let ruleId = rule?.id;
  let hookId: string | undefined;

  if (rule) trace.push(`rule:${rule.id} -> ${rule.decision}`);
  else trace.push(`rule:<none> -> ${DEFAULT_VERDICT} (default)`);

  const run = await hooks.run("preToolUse", {
    event: "preToolUse",
    tool: request.tool,
    input: original,
    turnId: request.turnId,
  });

  const input = run.input ?? original;
  const mutated = JSON.stringify(input) !== JSON.stringify(original);
  if (mutated) trace.push(`input -> ${JSON.stringify(input)}`);

  for (const record of run.records) {
    const outcome = record.outcome;
    trace.push(`hook:${record.hookId} -> ${outcome.kind}`);
    if (outcome.kind === "deny") {
      kind = "deny";
      reason = outcome.reason;
      source = "hook";
      hookId = record.hookId;
      break; // terminal
    }
    if (outcome.kind === "ask" || outcome.kind === "allow") {
      kind = outcome.kind;
      reason = outcome.reason ?? `${record.hookId} -> ${outcome.kind}`;
      source = "hook";
      hookId = record.hookId;
    }
    // "mutate" already shaped `input`; the verdict stays with the rule layer
    // unless the same hook also returned a verdict (it cannot).
  }

  return {
    kind,
    pending: kind === "ask",
    reason,
    source,
    ruleId,
    hookId,
    input,
    mutated,
    trace,
  };
}
