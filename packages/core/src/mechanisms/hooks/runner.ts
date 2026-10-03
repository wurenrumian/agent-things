/**
 * `HookRunner` — the ordered, matcher-aware dispatcher for lifecycle hooks.
 *
 * Hooks are kept in registration order and consulted in that order. Matching is
 * by event, then by tool name / tool regex, then by an argument regex. A hook
 * that returns `mutate` rewrites the working subject for every hook after it, so
 * mutations chain. A `deny` is terminal: nothing after it runs.
 */

import type {
  HookContext,
  HookDef,
  HookEvent,
  HookOutcomeRecord,
  HookRunResult,
} from "./types.js";

/** Compiled regexes, keyed by `flags\0source` (hook config is static). */
const regexCache = new Map<string, RegExp>();

/** Fail loudly on a bad config regex rather than silently never matching. */
function regex(source: string, flags = ""): RegExp {
  const key = `${flags}\u0000${source}`;
  let re = regexCache.get(key);
  if (!re) {
    re = new RegExp(source, flags);
    regexCache.set(key, re);
  }
  return re;
}

/**
 * The string an `argPattern` is tested against: serialized tool input for tool
 * events, the raw text for prompt/compact events.
 */
/**
 * The string an `argPattern` is tested against: serialized tool input, plus
 * every raw string argument on its own line. The raw values let path patterns
 * anchor with `^`/`$` (compiled with the `m` flag) without fighting JSON
 * quoting. Exported so the rule policy and the hook runner share one haystack.
 */
export function argumentHaystack(input: Record<string, unknown> | undefined): string {
  const values = Object.values(input ?? {}).filter(
    (value): value is string => typeof value === "string",
  );
  return [JSON.stringify(input ?? {}), ...values].join("\n");
}

function haystack(ctx: HookContext): string {
  if (ctx.tool !== undefined) return argumentHaystack(ctx.input);
  return ctx.text ?? "";
}

/** Does `hook` match this context (event + tool + arg pattern)? */
export function matchesHook(hook: HookDef, ctx: HookContext): boolean {
  if (!hook.events.includes(ctx.event)) return false;
  const m = hook.match;
  if (!m) return true;
  if (m.tool !== undefined && m.tool !== "*" && m.tool !== ctx.tool) return false;
  if (m.toolRegex !== undefined) {
    if (ctx.tool === undefined || !regex(m.toolRegex).test(ctx.tool)) return false;
  }
  if (m.argPattern !== undefined && !regex(m.argPattern, "m").test(haystack(ctx))) {
    return false;
  }
  return true;
}

export class HookRunner {
  private readonly hooks: HookDef[] = [];

  constructor(hooks: HookDef[] = []) {
    for (const hook of hooks) this.register(hook);
  }

  /** Append a hook (registration order is execution order). */
  register(hook: HookDef): this {
    this.hooks.push(hook);
    return this;
  }

  /** Snapshot of the registered hooks, in order. */
  list(): HookDef[] {
    return [...this.hooks];
  }

  /** Hooks that would fire for this context, in order (no execution). */
  matching(ctx: HookContext): HookDef[] {
    return this.hooks.filter((hook) => matchesHook(hook, ctx));
  }

  /**
   * Run every matching hook for `event`, threading mutations through the working
   * subject. Stops early on `deny` (terminal). Returns the audit records and the
   * final subject.
   */
  async run(event: HookEvent, ctx: HookContext): Promise<HookRunResult> {
    const records: HookOutcomeRecord[] = [];
    let input = ctx.input ? { ...ctx.input } : undefined;
    let text = ctx.text;

    for (const hook of this.hooks) {
      const current: HookContext = { ...ctx, event, input, text };
      if (!matchesHook(hook, current)) continue;

      const outcome = await hook.handler(current);
      if (!outcome) continue;
      records.push({ hookId: hook.id, event, outcome });

      if (outcome.kind === "mutate") {
        if (outcome.input !== undefined) input = { ...outcome.input };
        if (outcome.text !== undefined) text = outcome.text;
      }
      if (outcome.kind === "deny") break; // terminal
    }

    return { event, records, input, text };
  }

  /**
   * Convenience for the text lifecycle points (`userPromptSubmit`,
   * `preCompact`): returns the possibly-rewritten text plus the records.
   */
  async runText(
    event: HookEvent,
    text: string,
    turnId?: string,
  ): Promise<{ text: string; result: HookRunResult }> {
    const result = await this.run(event, { event, text, turnId });
    return { text: result.text ?? text, result };
  }
}
