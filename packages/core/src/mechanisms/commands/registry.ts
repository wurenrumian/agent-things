/**
 * M12 — slash commands: input **pre-processing**, not a model capability.
 *
 * ## The lesson in one sentence
 *
 * A slash command is not something the model can do; it is something the
 * *host* does to the input **before** deciding whether to call the model at
 * all. `/help` never reaches the provider; a registered command can either
 * answer synthetically (no model turn) or append a message at the **tail** of
 * the history and then run a normal turn.
 *
 * ## Why a registry and not a model tool
 *
 * Exposing these as tools would (a) cost schema tokens in the cached prefix and
 * (b) make the model responsible for routing. Intercepting at the edge keeps
 * the prefix stable: unknown slash input (e.g. `/etc/hosts`) is *not* a
 * command and falls through to the model untouched, and injected context is
 * only ever appended — never spliced into the system prefix (M1/M2 cache rule).
 *
 * Self-contained (`mechanisms/` 铁律): it imports only the kernel `types.js`.
 * The composition root supplies the mechanism-specific behaviour through
 * {@link CommandHost} (see `builtins.ts`).
 */

import type { ChatMessage } from "../../types.js";

/** A parsed command: the name without its slash, plus the raw argument tail. */
export interface ParsedCommand {
  /** Command name, lower-cased (e.g. `help`). */
  name: string;
  /** Everything after the name, trimmed (may be `""`). */
  args: string;
}

/** Where a command runs. Carried through untouched; commands stay stateless. */
export interface CommandContext {
  sessionId: string;
  cwd: string;
}

/**
 * What a command produces. Exactly one branch is expected:
 *
 * - `reply`  — a synthetic answer returned to the client **without a model
 *   turn** (the `/help`, `/memory`, `/workers`, `/compact` builtins).
 * - `inject` — messages appended at the **tail** of the message array, after
 *   which the server runs a normal model turn. Tail-only, so the cached
 *   system prefix is never rewritten.
 */
export interface CommandResult {
  /** Synthetic reply shown to the user; skips the model turn. */
  reply?: string;
  /** Tail messages to append before a model turn (cache-safe). */
  inject?: ChatMessage[];
  /** Optional structured detail for the `mechanism` event / observatory. */
  data?: unknown;
}

export type CommandHandler = (
  args: string,
  ctx: CommandContext,
) => CommandResult | Promise<CommandResult>;

/** One registered command. */
export interface CommandDef {
  /** Name without the leading slash (e.g. `help`). */
  name: string;
  /** One-line description shown by `/help`. */
  description: string;
  /** Usage line including the slash (e.g. `/memory <query>`). */
  usage: string;
  handler: CommandHandler;
}

/**
 * `/name` followed by either end-of-string or whitespace. Crucially this does
 * **not** match `/etc/hosts` (a path), so such input falls through to the model.
 */
const COMMAND_RE = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/;

/**
 * Parse a leading `/<name> [args]`. Returns `null` when `input` is not a
 * well-formed command — the caller then treats it as normal model input.
 *
 * ```ts
 * parseCommand("/memory cache rule"); // { name: "memory", args: "cache rule" }
 * parseCommand("/help");             // { name: "help", args: "" }
 * parseCommand("/etc/hosts");        // null  (a path, not a command)
 * parseCommand("hello");             // null
 * ```
 */
export function parseCommand(input: string): ParsedCommand | null {
  const text = input.trim();
  if (!text.startsWith("/")) return null;
  const match = COMMAND_RE.exec(text);
  if (!match) return null;
  return { name: match[1]!.toLowerCase(), args: (match[2] ?? "").trim() };
}

/**
 * An ordered, named collection of commands. Registration order is irrelevant to
 * output: {@link list} sorts by name so `/help` is stable (same
 * prompt-cache-friendly determinism rule as `ToolRegistry.list`).
 */
export class CommandRegistry {
  private readonly commands = new Map<string, CommandDef>();

  register(command: CommandDef): this {
    this.commands.set(command.name.toLowerCase(), command);
    return this;
  }

  get(name: string): CommandDef | undefined {
    return this.commands.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.commands.has(name.toLowerCase());
  }

  /** Registered commands, sorted by name. */
  list(): CommandDef[] {
    return [...this.commands.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /** Convenience passthrough so a caller needs only the registry. */
  parse(input: string): ParsedCommand | null {
    return parseCommand(input);
  }

  /** The `/help` body, built from the registry contents. */
  helpText(): string {
    const lines = ["Available commands:"];
    for (const command of this.list()) {
      lines.push(`  ${command.usage.padEnd(22)} ${command.description}`);
    }
    return lines.join("\n");
  }
}
