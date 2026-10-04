/**
 * M12 — the built-in slash commands.
 *
 * Four commands, each a thin adapter over a mechanism the server already wove:
 *
 *   `/help`           list the commands (synthetic; reads the registry)
 *   `/memory <query>` M9 `recall` — render top hits (synthetic, no model turn)
 *   `/workers`        M10 supervisor snapshot (synthetic, no model turn)
 *   `/compact`        M3 `compactNow` — force one compaction, render the report
 *
 * The mechanism-specific work is injected through {@link CommandHost} rather
 * than imported, which keeps this module dependency-free and free of
 * cross-mechanism coupling: the composition root supplies closures over the
 * real `recall` / `Supervisor` / `Agent.compactNow`, and each closure returns
 * `undefined` when its mechanism is disabled.
 */

import type { CommandRegistry } from "./registry.js";

/**
 * The host capabilities the built-ins need. All three are optional in spirit:
 * a closure returns `undefined` when its mechanism is off, and the command
 * answers with a clear "disabled" message instead of throwing.
 */
export interface CommandHost {
  /** M9: rendered memory matches for `query`, or `undefined` when memory is off. */
  recallMemory(query: string): string | undefined;
  /** M10: rendered supervisor snapshot, or `undefined` when orchestrator is off. */
  workerSnapshot(): string | undefined;
  /** M3: force one compaction now; rendered report, or `undefined` when off. */
  compactNow(): Promise<string | undefined>;
}

const MEMORY_DISABLED = "memory is disabled (set MEMORY_ENABLED=true).";
const ORCHESTRATOR_DISABLED =
  "orchestrator is disabled (set ORCHESTRATOR_ENABLED=true).";
const COMPACTION_DISABLED =
  "compaction is disabled (set COMPACT_THRESHOLD_TOKENS>0).";

/**
 * Register `/help`, `/memory`, `/workers`, `/compact` on `registry`. Call this
 * once per registry; it is the only place the built-in set is defined.
 */
export function registerBuiltins(
  registry: CommandRegistry,
  host: CommandHost,
): void {
  registry.register({
    name: "help",
    description: "list the available slash commands",
    usage: "/help",
    handler: () => ({ reply: registry.helpText() }),
  });

  registry.register({
    name: "memory",
    description: "recall memories by keyword (no model turn)",
    usage: "/memory <query>",
    handler: (args) => {
      const query = args.trim();
      if (query === "") return { reply: "Usage: /memory <query>" };
      const rendered = host.recallMemory(query);
      return { reply: rendered ?? MEMORY_DISABLED, data: { query } };
    },
  });

  registry.register({
    name: "workers",
    description: "show the orchestrator worker snapshot",
    usage: "/workers",
    handler: () => ({ reply: host.workerSnapshot() ?? ORCHESTRATOR_DISABLED }),
  });

  registry.register({
    name: "compact",
    description: "force one compaction of the live history",
    usage: "/compact",
    handler: async () => ({
      reply: (await host.compactNow()) ?? COMPACTION_DISABLED,
    }),
  });
}
