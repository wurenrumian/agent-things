/**
 * M11 — the lazy-exposure facade: `tool_search` + `tool_call`.
 *
 * `createToolSearchTools(realTools)` returns exactly two `ToolDef`s:
 *
 *   - `tool_search(query)` — searches the {@link ToolIndex} and returns the
 *     matching tools' signatures/descriptions *as a tool result*. Tool results
 *     are appended at the tail of the message array, so a tool's schema enters
 *     context on demand and never rewrites the cached request prefix (compare
 *     the M2 skill body and the M4 MCP measurements).
 *   - `tool_call(name, arguments)` — looks the real tool up by name, rejects
 *     unknown names, executes it, and returns its output. `arguments` may be a
 *     JSON object or a JSON-encoded string (some models double-encode it).
 *
 * The parent `Agent` is registered with **only these two tools**, so N real
 * tool schemas never enter the prefix. Registering the returned array through a
 * `ToolRegistry` gives the stable name ordering the prompt cache needs.
 *
 * Self-contained: no dependencies, only relative core imports.
 */

import type { AgentEvent } from "../../events.js";
import {
  ToolRegistry,
  type ToolContext,
  type ToolDef,
  type ToolResult,
} from "../../tools/registry.js";
import { ToolIndex, isRecord } from "./tool-index.js";

/** Something that can be turned into the real tool list. */
export type ToolSource = ToolDef[] | ToolRegistry;

/** Options for {@link createToolSearchTools}. */
export interface ToolSearchOptions {
  /** Max matches `tool_search` returns per call (default 8). */
  limit?: number;
  /** Name of the search tool (default `tool_search`). */
  searchToolName?: string;
  /** Name of the call tool (default `tool_call`). */
  callToolName?: string;
}

type ParsedArguments =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Accept arguments as an object, a JSON-encoded object, or absent. Anything
 * else is a caller error the model can correct on the next turn.
 */
function parseArguments(raw: unknown): ParsedArguments {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text === "") return { ok: true, value: {} };
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) {
        return { ok: false, error: "`arguments` must decode to a JSON object." };
      }
      return { ok: true, value: parsed };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `\`arguments\` is not valid JSON: ${message}` };
    }
  }
  if (isRecord(raw)) return { ok: true, value: raw };
  return {
    ok: false,
    error: "`arguments` must be an object (or a JSON-encoded object).",
  };
}

/**
 * Build the two facade tools bound to `source`.
 *
 * @param source the real tools — either a `ToolDef[]` or a full `ToolRegistry`
 *   (the latter is the mechanical integration path).
 */
export function createToolSearchTools(
  source: ToolSource,
  options: ToolSearchOptions = {},
): ToolDef[] {
  const realTools = source instanceof ToolRegistry ? source.list() : source;
  const index = new ToolIndex(realTools);
  const byName = new Map<string, ToolDef>();
  for (const tool of realTools) byName.set(tool.name, tool);

  const limit = options.limit ?? 8;
  const searchName = options.searchToolName ?? "tool_search";
  const callName = options.callToolName ?? "tool_call";

  const searchTool: ToolDef = {
    name: searchName,
    description:
      "Search the available tools by keyword. Matches tool names, descriptions, " +
      "and parameter names, and returns each match's signature and description. " +
      `Then invoke the chosen tool with ${callName}.`,
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords describing the capability you need.",
        },
        limit: {
          type: "integer",
          description: `Maximum matches to return (default ${limit}).`,
        },
      },
      required: ["query"],
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const query = typeof input["query"] === "string" ? input["query"] : "";
      const requested =
        typeof input["limit"] === "number" && Number.isFinite(input["limit"])
          ? Math.floor(input["limit"])
          : limit;
      const matches = index.search(query, requested);
      if (matches.length === 0) {
        return {
          output: `No tools matched "${query}". Try broader or different keywords.`,
        };
      }
      const lines = matches.map(
        (match) => `- ${match.signature}\n  ${match.description}`,
      );
      return {
        output:
          `Found ${matches.length} matching tool(s) for "${query}":\n` +
          lines.join("\n"),
      };
    },
  };

  const callTool: ToolDef = {
    name: callName,
    description:
      "Call a real tool by name with a JSON `arguments` object. Use " +
      `${searchName} first to discover the exact name and parameters. ` +
      "Unknown tool names are rejected.",
    readOnly: false,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: `Exact tool name (as returned by ${searchName}).`,
        },
        arguments: {
          type: "object",
          description: "Arguments object matching the tool's parameter signature.",
        },
      },
      required: ["name"],
    },
    async execute(
      input: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolResult> {
      const name = typeof input["name"] === "string" ? input["name"].trim() : "";
      if (name === "") {
        return {
          output: 'missing required string argument "name"',
          isError: true,
        };
      }
      const tool = byName.get(name);
      if (!tool) {
        return {
          output: `Unknown tool "${name}". Use ${searchName} to discover available tools.`,
          isError: true,
        };
      }
      const parsed = parseArguments(input["arguments"]);
      if (!parsed.ok) {
        return { output: `${callName}: ${parsed.error}`, isError: true };
      }

      // Observable, mechanism-agnostic progress: the loop relays these after
      // `tool.result`, exactly like any other mechanism tool.
      const dispatch: AgentEvent = {
        type: "mechanism",
        name: "tool-search",
        phase: "tool_call",
        data: { name },
        at: Date.now(),
      };
      try {
        const result: ToolResult = await tool.execute(parsed.value, ctx);
        return { ...result, events: [dispatch, ...(result.events ?? [])] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { output: message, isError: true, events: [dispatch] };
      }
    },
  };

  // Intent order: search first, then call. `ToolRegistry` re-sorts by name.
  return [searchTool, callTool];
}

/**
 * Wrap a real tool set in a `ToolRegistry` that exposes **only** the two facade
 * tools. This is the one-liner the integration wave needs:
 *
 * ```ts
 * const tools = createToolSearchRegistry(realRegistry);
 * const agent = new Agent({ ...config, tools }, sessionId);
 * ```
 */
export function createToolSearchRegistry(
  source: ToolSource,
  options: ToolSearchOptions = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of createToolSearchTools(source, options)) {
    registry.register(tool);
  }
  return registry;
}
