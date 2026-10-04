/**
 * L1 — cache-forensics experiment. **Zero API calls.**
 *
 * Run with:
 *   pnpm --filter @agent/server exec tsx scripts/forensics-experiment.ts
 *
 * It proves that `diffRequests()` (from `@agent/core`) classifies the *first
 * divergent block* of two request bodies the same way the recorded M1/M4 runs
 * observed the provider prompt cache behaving (`docs/runs/m1-cache.md`,
 * `docs/runs/m4-mcp.md`). No network, no `.env`, no server.
 *
 * Cases:
 *   1. identical body                  -> divergence "none"
 *   2. tools array reversed            -> "tools",  reordered: true
 *   3. one tool added                  -> "tools",  added: [name]
 *   4. system message changed 1 byte   -> "system"
 *   5. append-only message growth      -> "none",   messages.appended > 0
 *   6. tools identical, middle msg edit-> "messages", changedAt > prefix
 */

import {
  ToolRegistry,
  builtinTools,
  diffRequests,
  withCacheBreakpoint,
  type ChatMessage,
  type ChatRequest,
  type RequestDiff,
  type ToolSchema,
} from "@agent/core";

/* --------------------------------------------------------------- fixtures */

const MODEL = "xiaomi/mimo-v2.6-flash";

/** The real builtin tool set in `ToolRegistry.list()` order (5 tools). */
function baseTools(): ToolSchema[] {
  const registry = new ToolRegistry();
  for (const tool of builtinTools()) registry.register(tool);
  return registry.schemas();
}

const BASE_TOOLS = baseTools();

const EXTRA_TOOL: ToolSchema = {
  type: "function",
  function: {
    name: "fetch_url",
    description: "Fetch a URL over HTTP and return the response body as text.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute http(s) URL." } },
      required: ["url"],
    },
  },
};

const SENTINEL = "SENTINEL-AAAA";

function makeSystem(sentinel: string = SENTINEL): string {
  return [
    'You are a minimal coding agent running cache forensics "experiment".',
    `Sentinel: ${sentinel}.`,
    "Operation policy follows.",
    "Rule 000: keep the stable prefix stable; append-only edits preserve the cache.",
    "Rule 001: never rewrite an earlier message when appending new context.",
  ].join("\n");
}

function systemMessage(text: string): ChatMessage {
  return { role: "system", content: withCacheBreakpoint(text) };
}

function request(
  messages: ChatMessage[],
  tools: ToolSchema[] = BASE_TOOLS,
): ChatRequest {
  return { model: MODEL, messages, tools, temperature: 0 };
}

/** The healthy append-only growth curve from m1 §1.5 (grow#1 -> grow#2). */
function appendPair(): { prev: ChatRequest; next: ChatRequest } {
  const system = makeSystem();
  const prev = request([
    systemMessage(system),
    { role: "user", content: "Name one rule for keeping a prompt cache warm." },
  ]);
  const next = request([
    systemMessage(system),
    { role: "user", content: "Name one rule for keeping a prompt cache warm." },
    { role: "assistant", content: "Append only." },
    { role: "user", content: "Name one thing that invalidates it." },
  ]);
  return { prev, next };
}

/* ----------------------------------------------------------------- checks */

interface Check {
  /** Out-of-line assertions against the diff result. */
  assert: (diff: RequestDiff) => boolean;
  /** Human-readable expectation for the table. */
  detail: string;
}

interface Case {
  index: number;
  name: string;
  /** The expected first divergent block. */
  expected: RequestDiff["divergence"];
  prev: ChatRequest;
  next: ChatRequest;
  check: Check;
}

function buildCases(): Case[] {
  const system = makeSystem();

  const identicalPrev = request([
    systemMessage(system),
    { role: "user", content: "Reply with exactly one word: ok" },
  ]);

  const reversedTools = [...BASE_TOOLS].reverse();

  const middleBase = request([
    systemMessage(system),
    { role: "user", content: "task" },
    { role: "assistant", content: "calling read_file" },
    { role: "tool", tool_call_id: "call_0", content: "KEEP-ME-ORIGINAL" },
    { role: "user", content: "thanks" },
  ]);
  const middleEdited = request([
    systemMessage(system),
    { role: "user", content: "task" },
    { role: "assistant", content: "calling read_file" },
    { role: "tool", tool_call_id: "call_0", content: "NOW-EDITED-XXXXX" },
    { role: "user", content: "thanks" },
  ]);

  const append = appendPair();

  return [
    {
      index: 1,
      name: "identical bodies",
      expected: "none",
      prev: identicalPrev,
      next: request([
        systemMessage(system),
        { role: "user", content: "Reply with exactly one word: ok" },
      ]),
      check: {
        detail: "none · no change anywhere",
        assert: (d) =>
          d.divergence === "none" &&
          d.system.same &&
          d.tools.same &&
          d.messages.changedAt === undefined &&
          d.messages.appended === 0,
      },
    },
    {
      index: 2,
      name: "tools reversed",
      expected: "tools",
      prev: identicalPrev,
      next: request(
        [
          systemMessage(system),
          { role: "user", content: "Reply with exactly one word: ok" },
        ],
        reversedTools,
      ),
      check: {
        detail: "tools · reordered: true",
        assert: (d) =>
          d.divergence === "tools" &&
          d.tools.reordered === true &&
          d.tools.added.length === 0 &&
          d.tools.removed.length === 0,
      },
    },
    {
      index: 3,
      name: "one tool added (fetch_url)",
      expected: "tools",
      prev: identicalPrev,
      next: request(
        [
          systemMessage(system),
          { role: "user", content: "Reply with exactly one word: ok" },
        ],
        [...BASE_TOOLS, EXTRA_TOOL],
      ),
      check: {
        detail: 'tools · added: ["fetch_url"]',
        assert: (d) =>
          d.divergence === "tools" &&
          d.tools.added.length === 1 &&
          d.tools.added[0] === "fetch_url" &&
          d.tools.reordered === false,
      },
    },
    {
      index: 4,
      name: "system changed 1 byte",
      expected: "system",
      prev: identicalPrev,
      next: request([
        systemMessage(makeSystem("SENTINEL-AAAB")),
        { role: "user", content: "Reply with exactly one word: ok" },
      ]),
      check: {
        detail: "system · changedAt set",
        assert: (d) =>
          d.divergence === "system" &&
          d.system.same === false &&
          typeof d.system.changedAt === "number",
      },
    },
    {
      index: 5,
      name: "append-only messages",
      expected: "none",
      prev: append.prev,
      next: append.next,
      check: {
        detail: "none · messages.appended > 0",
        assert: (d) =>
          d.divergence === "none" &&
          d.messages.appended > 0 &&
          d.messages.changedAt === undefined &&
          d.tools.same &&
          d.system.same,
      },
    },
    {
      index: 6,
      name: "tools identical, middle message edited",
      expected: "messages",
      prev: middleBase,
      next: middleEdited,
      check: {
        detail: "messages · changedAt > 0, prefix survives",
        assert: (d) =>
          d.divergence === "messages" &&
          typeof d.messages.changedAt === "number" &&
          d.messages.changedAt > 0 &&
          d.messages.prefixLen > 0 &&
          d.messages.appended === 0,
      },
    },
  ];
}

/* ------------------------------------------------------------------ table */

interface Row {
  index: number;
  name: string;
  expected: string;
  actual: string;
  detail: string;
  pass: boolean;
}

function pad(value: string, width: number, right = false): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

function printTable(rows: Row[]): void {
  const headers = ["#", "case", "expected", "actual", "verdict", "detail"];
  const body = rows.map((r) => [
    String(r.index),
    r.name,
    r.expected,
    r.actual,
    r.pass ? "PASS" : "FAIL",
    `${r.detail}${r.pass ? "" : "  <-- mismatch"}`,
  ]);
  const widths = headers.map((h, c) =>
    Math.max(h.length, ...body.map((row) => row[c]!.length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, c) => pad(cell, widths[c]!, c === 0 || c === 2 || c === 3 || c === 4)).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) console.log(line(row));
}

/* ------------------------------------------------------------------- main */

function main(): void {
  console.log("forensics-experiment — diffRequests classifier (zero API calls)");
  console.log(`model=${MODEL}  builtin tools=${BASE_TOOLS.length}\n`);

  const rows: Row[] = [];
  for (const c of buildCases()) {
    const diff = diffRequests(c.prev, c.next);
    const pass = diff.divergence === c.expected && c.check.assert(diff);
    rows.push({
      index: c.index,
      name: c.name,
      expected: c.expected,
      actual: diff.divergence,
      detail: c.check.detail,
      pass,
    });
  }

  printTable(rows);

  const failed = rows.filter((r) => !r.pass);
  const allPass = failed.length === 0;
  console.log(
    `\n${allPass ? "ALL PASS" : `${failed.length} FAILED`} — ${rows.length - failed.length}/${rows.length} cases`,
  );
  if (!allPass) process.exitCode = 1;
}

main();
