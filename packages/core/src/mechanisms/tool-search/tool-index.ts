/**
 * M11 — deterministic tool index (the "search" half of lazy tool exposure).
 *
 * Eager schema injection puts every tool's full JSON schema in the request
 * prefix on every call. Lazy exposure instead keeps a tiny searchable facade
 * resident and pulls a tool's schema on demand. This module is the index behind
 * that facade.
 *
 * Design rules (see docs/mechanisms/tool-search.md):
 *   - **No embeddings.** Ranking is keyword overlap over three fields — the
 *     tool name, its description, and its parameter names.
 *   - **Deterministic.** The same tool set and query always produce the same
 *     order: ties break by tool name (`localeCompare`), never by input order.
 *     That is what keeps the resident facade's output stable.
 *   - **Self-contained.** Only `ToolDef`/`JSONSchema` types, no dependencies.
 */

import type { JSONSchema } from "../../types.js";
import type { ToolDef } from "../../tools/registry.js";

/** One indexed tool, as exposed to the model by `tool_search`. */
export interface ToolIndexEntry {
  name: string;
  description: string;
  /**
   * Call-shaped parameter signature, e.g.
   * `read_file(path: string, offset?: integer, limit?: integer)`.
   */
  signature: string;
  /** The raw JSON Schema, kept for callers that want to validate arguments. */
  parameters: JSONSchema;
}

/** A ranked search hit: the entry plus its deterministic relevance score. */
export interface ToolMatch extends ToolIndexEntry {
  score: number;
}

/** Field weights. A name hit beats a parameter hit beats a description hit. */
const NAME_WEIGHT = 4;
const PARAM_WEIGHT = 2;
const DESC_WEIGHT = 1;
/** A query equal to the whole tool name always wins. */
const EXACT_NAME_BONUS = 100;
const DEFAULT_LIMIT = 8;

/** Narrow an unknown JSON value to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Split prose / camelCase / snake_case / kebab-case into lowercase word tokens.
 * Single characters are dropped: they carry almost no signal and would make
 * ranking noisy.
 */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

/**
 * Token equality with a light prefix tolerance, so "words" matches "word" and
 * "counting" matches "count" without a real stemmer. Both directions are tried,
 * but only across tokens of length >= 3 to avoid spurious short prefixes.
 */
function tokenMatches(queryToken: string, docToken: string): boolean {
  if (queryToken === docToken) return true;
  if (queryToken.length >= 3 && docToken.startsWith(queryToken)) return true;
  if (docToken.length >= 3 && queryToken.startsWith(docToken)) return true;
  return false;
}

/** Render a tool's parameters as `name(type, other?: type)` (sorted by name). */
export function parameterSignature(name: string, parameters: JSONSchema): string {
  const props = isRecord(parameters["properties"]) ? parameters["properties"] : {};
  const rawRequired = parameters["required"];
  const required = new Set(
    Array.isArray(rawRequired)
      ? rawRequired.filter((value): value is string => typeof value === "string")
      : [],
  );
  const names = Object.keys(props).sort((a, b) => a.localeCompare(b));
  const parts = names.map((param) => {
    const schema = isRecord(props[param]) ? props[param] : {};
    const type = typeof schema["type"] === "string" ? schema["type"] : "any";
    return `${param}${required.has(param) ? "" : "?"}: ${type}`;
  });
  return `${name}(${parts.join(", ")})`;
}

/** A tool plus its pre-tokenized, pre-normalized index fields. */
interface IndexedTool {
  entry: ToolIndexEntry;
  nameTokens: string[];
  paramTokens: string[];
  descTokens: string[];
  /** Name lowercased with separators removed, for whole-name matching. */
  compactName: string;
}

/** Unique tokens, deterministically ordered by first appearance. */
function uniqueTokens(text: string): string[] {
  return [...new Set(tokenize(text))];
}

function indexTool(tool: ToolDef): IndexedTool {
  const props = isRecord(tool.parameters["properties"])
    ? tool.parameters["properties"]
    : {};
  const paramNames = Object.keys(props);
  return {
    entry: {
      name: tool.name,
      description: tool.description,
      signature: parameterSignature(tool.name, tool.parameters),
      parameters: tool.parameters,
    },
    nameTokens: uniqueTokens(tool.name),
    paramTokens: uniqueTokens(paramNames.join(" ")),
    descTokens: uniqueTokens(tool.description),
    compactName: tool.name.toLowerCase().replace(/[^a-z0-9]/g, ""),
  };
}

/**
 * A deterministic keyword index over a set of {@link ToolDef}s.
 *
 * `search()` ranks tools by overlap between the query tokens and the tool's
 * name/parameters/description. Duplicate tool names collapse (last definition
 * wins, matching `ToolRegistry.register`), and every listing is sorted by name.
 */
export class ToolIndex {
  private readonly indexed: IndexedTool[];

  constructor(tools: ToolDef[]) {
    const byName = new Map<string, ToolDef>();
    for (const tool of tools) byName.set(tool.name, tool);
    this.indexed = [...byName.values()]
      .map(indexTool)
      .sort((a, b) => a.entry.name.localeCompare(b.entry.name));
  }

  /** Number of distinct tools in the index. */
  size(): number {
    return this.indexed.length;
  }

  /** All entries, deterministically ordered by name. */
  entries(): ToolIndexEntry[] {
    return this.indexed.map((tool) => tool.entry);
  }

  /** The entry for an exact tool name, if present. */
  get(name: string): ToolIndexEntry | undefined {
    return this.indexed.find((tool) => tool.entry.name === name)?.entry;
  }

  /**
   * Rank tools against `query`. Returns at most `limit` matches, strongest
   * first; ties break by name. An empty query (or no overlap) returns `[]`.
   */
  search(query: string, limit: number = DEFAULT_LIMIT): ToolMatch[] {
    const trimmed = query.trim();
    if (trimmed === "") return [];

    const queryTokens = uniqueTokens(trimmed);
    const compactQuery = trimmed.toLowerCase().replace(/[^a-z0-9]/g, "");
    const matches: ToolMatch[] = [];

    for (const tool of this.indexed) {
      let score = 0;
      for (const queryToken of queryTokens) {
        if (tool.nameTokens.some((t) => tokenMatches(queryToken, t))) {
          score += NAME_WEIGHT;
        } else if (tool.paramTokens.some((t) => tokenMatches(queryToken, t))) {
          score += PARAM_WEIGHT;
        } else if (tool.descTokens.some((t) => tokenMatches(queryToken, t))) {
          score += DESC_WEIGHT;
        }
      }
      if (compactQuery !== "" && compactQuery === tool.compactName) {
        score += EXACT_NAME_BONUS;
      }
      if (score > 0) matches.push({ ...tool.entry, score });
    }

    matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const cap = Math.max(1, Math.floor(limit));
    return matches.slice(0, cap);
  }
}
