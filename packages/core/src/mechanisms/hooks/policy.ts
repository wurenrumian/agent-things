/**
 * Ordered rule-based permission policy (M6, L7 in MECHANISMS.md).
 *
 * This is deliberately **not** the existing `core/src/permissions.ts` (which is
 * a three-mode coarse gate). It is the richer, data-driven layer: an ordered
 * list of `{ tool, argPattern?, decision }` rules where the **first match wins**
 * and the decision is `allow | ask | deny`. `ask` is modelled as *pending* — a
 * decision a UI could resolve later — never as an interactive prompt.
 *
 * The policy is combined with hooks by {@link decide} in `decide.ts`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fixtureDir } from "./config.js";
import { argumentHaystack } from "./runner.js";

/** The three verdicts a rule can produce. */
export type PermissionVerdict = "allow" | "ask" | "deny";

/** One ordered rule. */
export interface PermissionRule {
  id: string;
  /** Exact tool name, or `"*"` for any tool. */
  tool: string;
  /** Regex source tested against `JSON.stringify(input)`. */
  argPattern?: string;
  decision: PermissionVerdict;
  reason?: string;
}

const VERDICTS: readonly PermissionVerdict[] = ["allow", "ask", "deny"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRule(raw: unknown, index: number): PermissionRule {
  if (!isObject(raw)) throw new Error(`policy: rule #${index} must be an object`);
  const id = raw["id"];
  const tool = raw["tool"];
  const decision = raw["decision"];
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`policy: rule #${index} needs a non-empty "id"`);
  }
  if (tool !== "*" && (typeof tool !== "string" || tool.length === 0)) {
    throw new Error(`policy: rule "${id}" needs a "tool" name or "*"`);
  }
  if (!VERDICTS.includes(decision as PermissionVerdict)) {
    throw new Error(`policy: rule "${id}" decision must be allow|ask|deny`);
  }
  const rule: PermissionRule = {
    id,
    tool: tool as string,
    decision: decision as PermissionVerdict,
  };
  const pattern = raw["argPattern"];
  if (pattern !== undefined) {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new Error(`policy: rule "${id}" argPattern must be a non-empty string`);
    }
    new RegExp(pattern); // fail fast on an invalid pattern
    rule.argPattern = pattern;
  }
  const reason = raw["reason"];
  if (reason !== undefined) {
    if (typeof reason !== "string") throw new Error(`policy: rule "${id}" reason must be a string`);
    rule.reason = reason;
  }
  return rule;
}

/** Validate a `{ rules: [...] }` body. */
export function parseRules(raw: unknown): PermissionRule[] {
  if (!isObject(raw)) throw new Error("policy: root must be an object");
  const list = raw["rules"];
  if (!Array.isArray(list)) throw new Error('policy: root needs a "rules" array');
  return list.map((entry, index) => parseRule(entry, index));
}

export class Policy {
  private readonly rules: PermissionRule[];

  constructor(rules: PermissionRule[]) {
    this.rules = [...rules];
  }

  static fromJson(raw: unknown): Policy {
    return new Policy(parseRules(raw));
  }

  static async fromFile(file: string): Promise<Policy> {
    return Policy.fromJson(JSON.parse(await readFile(file, "utf8")) as unknown);
  }

  /** Load the bundled demo rules (default `rules.json`). */
  static async fromFixture(name = "rules.json"): Promise<Policy> {
    return Policy.fromFile(path.join(fixtureDir(), name));
  }

  /** The ordered rules. */
  list(): PermissionRule[] {
    return [...this.rules];
  }

  /** First matching rule for the request, or `undefined` (caller applies default). */
  match(request: { tool: string; input: Record<string, unknown> }): PermissionRule | undefined {
    const haystack = argumentHaystack(request.input);
    for (const rule of this.rules) {
      if (rule.tool !== "*" && rule.tool !== request.tool) continue;
      if (rule.argPattern !== undefined && !new RegExp(rule.argPattern, "m").test(haystack)) {
        continue;
      }
      return rule;
    }
    return undefined;
  }
}
