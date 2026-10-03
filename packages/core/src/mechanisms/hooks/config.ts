/**
 * Hook config loading — declarative hooks from a JSON file.
 *
 * A JSON hook is either a **verdict** hook (fixed `allow|ask|deny`) or a
 * **mutation** hook (a small `replace|append|prepend|set` operation against one
 * named tool argument, or the prompt text). The loader compiles each entry into
 * a normal `HookDef` whose handler receives the live context, so declarative and
 * hand-written hooks are indistinguishable to the runner.
 *
 * Self-contained: only `node:fs` / `node:path` / `node:url`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOOK_EVENTS,
  type HookDef,
  type HookEvent,
  type HookHandler,
  type HookMatch,
  type HookOutcome,
} from "./types.js";

/** A declarative mutation, applied by the compiled handler. */
export interface MutationSpec {
  /** Tool-argument name for tool events, or `"text"` for text events. */
  target: string;
  op: "replace" | "append" | "prepend" | "set";
  /** Required for `replace` (regex source). */
  pattern?: string;
  /** Regex flags for `replace`. */
  flags?: string;
  /** Replacement / appended / prepended value; arbitrary JSON for `set`. */
  value?: unknown;
  reason?: string;
}

/** One hook as it appears in the JSON fixture. */
export interface RawHook {
  id: string;
  /** Preferred plural form. */
  events?: HookEvent[];
  /** Singular convenience form. */
  event?: HookEvent;
  match?: HookMatch;
  decision?: "allow" | "ask" | "deny";
  reason?: string;
  note?: string;
  mutate?: MutationSpec;
}

export interface HooksFile {
  hooks: RawHook[];
}

/* ------------------------------------------------------------- validation */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`hook config: ${what} must be a non-empty string`);
  }
  return value;
}

function parseEvents(raw: RawHook, where: string): HookEvent[] {
  const source = raw.events ?? (raw.event ? [raw.event] : undefined);
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error(`hook config: ${where} needs "events" or "event"`);
  }
  const events: HookEvent[] = [];
  for (const event of source) {
    if (!HOOK_EVENTS.includes(event)) {
      throw new Error(`hook config: ${where} has unknown event "${String(event)}"`);
    }
    events.push(event);
  }
  return events;
}

function parseMatch(raw: unknown, where: string): HookMatch | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new Error(`hook config: ${where}.match must be an object`);
  const match: HookMatch = {};
  if (raw["tool"] !== undefined) match.tool = requireString(raw["tool"], `${where}.match.tool`);
  if (raw["toolRegex"] !== undefined) {
    match.toolRegex = requireString(raw["toolRegex"], `${where}.match.toolRegex`);
    new RegExp(match.toolRegex); // validate now, fail fast
  }
  if (raw["argPattern"] !== undefined) {
    match.argPattern = requireString(raw["argPattern"], `${where}.match.argPattern`);
    new RegExp(match.argPattern);
  }
  return match;
}

function parseMutation(raw: unknown, where: string): MutationSpec | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) throw new Error(`hook config: ${where}.mutate must be an object`);
  const target = requireString(raw["target"], `${where}.mutate.target`);
  const op = raw["op"];
  if (op !== "replace" && op !== "append" && op !== "prepend" && op !== "set") {
    throw new Error(`hook config: ${where}.mutate.op must be replace|append|prepend|set`);
  }
  const spec: MutationSpec = { target, op };
  if (raw["pattern"] !== undefined) {
    spec.pattern = requireString(raw["pattern"], `${where}.mutate.pattern`);
    new RegExp(spec.pattern, typeof raw["flags"] === "string" ? raw["flags"] : "");
  }
  if (op === "replace" && spec.pattern === undefined) {
    throw new Error(`hook config: ${where}.mutate.op=replace requires "pattern"`);
  }
  if (raw["flags"] !== undefined) spec.flags = requireString(raw["flags"], `${where}.mutate.flags`);
  if (raw["value"] !== undefined) spec.value = raw["value"];
  if (raw["reason"] !== undefined) spec.reason = requireString(raw["reason"], `${where}.mutate.reason`);
  return spec;
}

/* ------------------------------------------------------------- compilation */

interface OpResult {
  changed: boolean;
  value: unknown;
}

/** Apply one declarative op to the current value. */
function applyOp(current: unknown, spec: MutationSpec): OpResult {
  switch (spec.op) {
    case "set":
      return { changed: true, value: spec.value };
    case "append": {
      const base = typeof current === "string" ? current : "";
      const next = base + String(spec.value ?? "");
      return { changed: next !== current, value: next };
    }
    case "prepend": {
      const base = typeof current === "string" ? current : "";
      const next = String(spec.value ?? "") + base;
      return { changed: next !== current, value: next };
    }
    case "replace": {
      if (typeof current !== "string") return { changed: false, value: current };
      const next = current.replace(new RegExp(spec.pattern!, spec.flags ?? ""), String(spec.value ?? ""));
      return { changed: next !== current, value: next };
    }
  }
}

/** Compile one JSON entry into an executable {@link HookDef}. */
export function declarativeHook(raw: RawHook): HookDef {
  const where = `hook "${raw.id ?? "?"}"`;
  const id = requireString(raw.id, "hook.id");
  const events = parseEvents(raw, where);
  const match = parseMatch(raw.match, where);
  const mutate = parseMutation(raw.mutate, where);

  if (mutate === undefined && raw.decision === undefined) {
    throw new Error(`hook config: ${where} needs "decision" or "mutate"`);
  }

  const handler: HookHandler = (ctx) => {
    if (mutate) {
      if (ctx.tool !== undefined) {
        const current = ctx.input?.[mutate.target];
        const result = applyOp(current, mutate);
        if (!result.changed) return undefined;
        return {
          kind: "mutate",
          input: { ...(ctx.input ?? {}), [mutate.target]: result.value },
          reason: mutate.reason ?? raw.reason,
          note: raw.note,
        };
      }
      if (mutate.target !== "text") {
        throw new Error(`${where}: text events may only mutate target "text"`);
      }
      const result = applyOp(ctx.text ?? "", mutate);
      if (!result.changed) return undefined;
      return {
        kind: "mutate",
        text: String(result.value),
        reason: mutate.reason ?? raw.reason,
        note: raw.note,
      };
    }
    const kind = raw.decision!;
    return {
      kind,
      reason: raw.reason ?? `${id} -> ${kind}`,
      note: raw.note,
    } as HookOutcome;
  };

  return { id, events, match, handler };
}

/** Validate and compile the `{ hooks: [...] }` file body. */
export function parseHooks(raw: unknown): HookDef[] {
  if (!isObject(raw)) throw new Error("hooks config: root must be an object");
  const list = raw["hooks"];
  if (!Array.isArray(list)) throw new Error('hooks config: root needs a "hooks" array');
  return list.map((entry) => {
    if (!isObject(entry)) throw new Error("hooks config: every hook must be an object");
    return declarativeHook(entry as unknown as RawHook);
  });
}

/* ------------------------------------------------------------------ files */

/** The bundled fixtures directory. */
export function fixtureDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "fixtures");
}

/** Parse a hooks JSON file from an explicit path. */
export async function loadHooksFile(file: string): Promise<HookDef[]> {
  const text = await readFile(file, "utf8");
  return parseHooks(JSON.parse(text) as unknown);
}

/** Load the bundled demo hooks (default `hooks.json`). */
export async function loadHooksFromFixture(name = "hooks.json"): Promise<HookDef[]> {
  return loadHooksFile(path.join(fixtureDir(), name));
}
