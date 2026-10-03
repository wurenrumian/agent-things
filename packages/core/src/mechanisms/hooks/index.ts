/**
 * M6 — hooks, permissions & checkpoint: the hooks mechanism.
 *
 * Public surface:
 *   - types    : HookEvent, HookOutcome, HookContext, HookDef, ...
 *   - runner   : HookRunner (match by name/regex, chain mutations, terminal deny)
 *   - config   : declarative hooks from JSON (loadHooksFromFixture)
 *   - policy   : ordered { tool, argPattern?, decision } rules (Policy)
 *   - decide   : combine policy + hooks into one Decision
 */

export * from "./types.js";
export * from "./runner.js";
export * from "./config.js";
export * from "./policy.js";
export * from "./decide.js";
