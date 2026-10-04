/**
 * M12 — slash commands (input pre-processing).
 *
 * Public surface:
 *   - `registry`: {@link CommandRegistry}, {@link parseCommand}, command types
 *   - `builtins`: {@link registerBuiltins}, {@link CommandHost}
 *
 * See `docs/mechanisms/commands.md` for the lesson and the injection point.
 */

export * from "./registry.js";
export * from "./builtins.js";
