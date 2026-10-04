/**
 * M9 — the `memory` ToolDef.
 *
 * One tool, four actions: `save` | `list` | `search` | `forget`. It is the
 * model-facing half of the memory mechanism. Its `execute()` output is the
 * **only** thing that enters the model's context, and the loop appends it as a
 * `role: "tool"` message at the **tail** of the message array. That is the
 * whole design: retrieval results are appended, never spliced into the system
 * prefix, so pulling a memory into context cannot invalidate the prompt cache.
 *
 * The executor is intentionally thin — it delegates to a `MemoryStore` and
 * formats with `renderMemories`. It never touches conversation state.
 *
 * `readOnly` is `false` because `save`/`forget` mutate durable state. A single
 * `ToolDef` has one flag, so the conservative value wins; in `standard` mode
 * that means even `search` is gated, which the integration wave can refine by
 * splitting the tool if it wants the reads to be freely allowed.
 */

import type { JSONSchema } from "../../types.js";
import type { ToolResult } from "../../tools/registry.js";
import type { ToolContext, ToolDef } from "../../tools/registry.js";
import { renderMemories } from "./render.js";
import type { MemoryStore } from "./store.js";

/** The registered tool name. */
export const MEMORY_TOOL_NAME = "memory";

const ACTIONS = ["save", "list", "search", "forget"] as const;
export type MemoryAction = (typeof ACTIONS)[number];

/** Options for {@link createMemoryTool}. */
export interface MemoryToolOptions {
  /** Default result count for `search` (default 5). */
  defaultLimit?: number;
  /** Cap on entries returned by `list` (default 50, newest kept). */
  listLimit?: number;
}

const PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...ACTIONS],
      description:
        "What to do: `save` a new fact, `list` everything, `search` by " +
        "keywords, or `forget` one entry by id.",
    },
    text: {
      type: "string",
      description: "For `save`: the fact to remember (one self-contained statement).",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "For `save`: optional labels to make the fact easier to find later.",
    },
    query: {
      type: "string",
      description: "For `search`: keywords describing the fact you need.",
    },
    id: {
      type: "string",
      description: "For `forget`: the id of the entry to remove.",
    },
    limit: {
      type: "integer",
      description: "For `search`: maximum number of entries to return.",
    },
  },
  required: ["action"],
};

/** Coerce a possibly-undefined tool argument to a positive integer. */
function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

/** Collect a string-array tool argument, dropping non-strings. */
function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string");
  return out.length > 0 ? out : undefined;
}

/**
 * Build the `memory` tool bound to a store. Register it in the agent's
 * `ToolRegistry`; the loop runs `execute()` and appends the returned string as
 * a tool result at the tail.
 */
export function createMemoryTool(
  store: MemoryStore,
  options: MemoryToolOptions = {},
): ToolDef {
  const defaultLimit = options.defaultLimit ?? 5;
  const listLimit = options.listLimit ?? 50;

  return {
    name: MEMORY_TOOL_NAME,
    description:
      "Read and write persistent memory that survives across sessions. " +
      "Use `save` to remember a durable fact, `search` to recall facts by " +
      "keywords, `list` to see everything, and `forget` to delete an entry by " +
      "id. Retrieval output is returned as a tool result, so it never rewrites " +
      "the system prompt.",
    readOnly: false,
    parameters: PARAMETERS,
    async execute(
      input: Record<string, unknown>,
      _ctx: ToolContext,
    ): Promise<ToolResult> {
      const action = typeof input["action"] === "string" ? input["action"].trim() : "";

      switch (action) {
        case "save": {
          const text = typeof input["text"] === "string" ? input["text"].trim() : "";
          if (text === "") {
            return {
              output: 'memory: action "save" requires a non-empty "text" string.',
              isError: true,
            };
          }
          const entry = await store.save(text, toStringArray(input["tags"]));
          return {
            output: `Saved ${entry.id}.\n${renderMemories([entry])}`,
          };
        }

        case "list": {
          const entries = store.all();
          const shown = entries.slice(Math.max(0, entries.length - listLimit));
          return { output: renderMemories(shown) };
        }

        case "search": {
          const query = typeof input["query"] === "string" ? input["query"] : "";
          const limit = toPositiveInt(input["limit"], defaultLimit);
          const hits = store.search(query, limit);
          if (hits.length === 0) {
            return {
              output: `${renderMemories([])}\nNo memory matched "${query}".`,
            };
          }
          return { output: renderMemories(hits) };
        }

        case "forget": {
          const id = typeof input["id"] === "string" ? input["id"].trim() : "";
          if (id === "") {
            return {
              output: 'memory: action "forget" requires an "id" string.',
              isError: true,
            };
          }
          const removed = await store.forget(id);
          return {
            output: removed
              ? `Forgot ${id}.`
              : `No memory with id ${id} (nothing changed).`,
          };
        }

        default:
          return {
            output:
              `memory: unknown action "${action}". ` +
              `Expected one of: ${ACTIONS.join(", ")}.`,
            isError: true,
          };
      }
    },
  };
}
