/**
 * M3 — compaction & context reclamation experiment harness.
 *
 * Run with:
 *   pnpm --filter @agent/server exec tsx scripts/compaction-experiment.ts --salt=mimo-m3-001
 *   pnpm --filter @agent/server exec tsx scripts/compaction-experiment.ts selftest   # no API calls
 *
 * Question (MECHANISMS §6 Q3, §4): compaction necessarily rewrites the cached
 * history prefix. How fast does the cache recover, and does *where the summary
 * goes* change the curve?
 *
 *   spliced  — summary replaces the summarized span in place, after the retained
 *              leading messages  ->  [system][leading][summary][tail]
 *   leading  — summary pinned to a fixed leading slot right after system
 *                                 ->  [system][summary][leading][tail]
 *
 * For each placement we make 8 calls over one logical conversation:
 *   pre#1, pre#2        establish + confirm the cache on the *uncompacted* view
 *   compact#1, compact#2    first + second identical post-compaction request
 *   follow#1, follow#2      append-only turns on the compacted view
 *   repack#1, repack#2      a *second* compaction (does a stable prefix survive?)
 *
 * `clear` makes 5 calls: pre#1, pre#2, clear#1, clear#2, follow#1.
 *
 * Every number printed is the provider's real
 * `usage.prompt_tokens_details.cached_tokens` for that call. The summarizer is a
 * deterministic stub so the two placements see byte-identical summaries; the
 * primitive itself awaits a caller-injected function (a real model call is a
 * drop-in).
 *
 * Pass `--salt=<value>` to pin the run prefix; on HTTP 429 the harness backs off
 * (2s / 4s) and retries. Base budget: 21 calls.
 */

import {
  OpenRouterClient,
  ToolRegistry,
  builtinTools,
  contentToText,
  estimateTokens,
  withCacheBreakpoint,
  type ChatMessage,
  type ToolSchema,
  type Usage,
} from "@agent/core";
import { loadConfig } from "../src/config.js";
import {
  clearToolResultsDetailed,
  compactDetailed,
  validateToolTranscript,
  type CompactOptions,
  type SummaryPlacement,
} from "../../core/src/mechanisms/compaction/index.js";

const config = loadConfig();
const client = new OpenRouterClient({
  apiKey: config.apiKey,
  referer: config.referer,
  title: config.title,
});

const MODEL = config.model;
const TEMPERATURE = 0;
const MAX_TOKENS = 16;
const CALL_DELAY_MS = 500;
const MAX_ATTEMPTS = 3;

const SALT =
  process.argv.find((a) => a.startsWith("--salt="))?.slice("--salt=".length) ||
  Date.now().toString(36);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- fixtures */

/** Long deterministic corpus: pushes the stable prefix past the min cache block. */
function stableCorpus(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(
      `Rule ${String(i).padStart(3, "0")}: keep the stable prefix stable; ` +
        `never rewrite an earlier message when appending new context; ` +
        `append-only edits preserve the provider prompt cache.`,
    );
  }
  return out.join("\n");
}

/** A bulky, deterministic "project brief" retained before the summarized span. */
function briefCorpus(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(
      `Brief ${String(i).padStart(3, "0")}: the objective is to implement ` +
        `compaction and tool-result clearing as pure message-array transforms, ` +
        `then measure the provider prompt-cache recovery curve.`,
    );
  }
  return out.join("\n");
}

/** A bulky, deterministic fake file read (the stale tool output we reclaim). */
function fileBlob(turn: number): string {
  const out: string[] = [];
  for (let i = 0; i < 60; i++) {
    out.push(
      `${i + 1}\t// src/module-${turn}.ts: deterministic stale tool output ` +
        `line ${i} used to make the transcript genuinely bulky.`,
    );
    out.push(
      `${i + 1}\texport const value_${turn}_${i} = ${i}; // filler`,
    );
  }
  return out.join("\n");
}

function makeSystem(tag: string): string {
  return [
    `You are a minimal coding agent running compaction experiment "${tag}@${SALT}".`,
    "Reply with exactly one word when asked; never call a tool.",
    "",
    stableCorpus(90),
  ].join("\n");
}

function systemMessage(text: string): ChatMessage {
  return { role: "system", content: withCacheBreakpoint(text) };
}

function baseTools(): ToolSchema[] {
  const registry = new ToolRegistry();
  for (const tool of builtinTools()) registry.register(tool);
  return registry.schemas();
}

const TOOLS = baseTools();

/* ---------------------------------------------------- the conversation under test */

const TOOL_TURNS = 10;
const KEEP_LEADING = 1;
const KEEP_RECENT = 3;
const CLEAR_KEEP_LAST = 4;

const RECENT_USER = "We are wrapping up. Name the one invariant we protected.";
const RECENT_ASSISTANT =
  "Prefix stability: append to the tail, never rewrite the cached prefix.";
const FINAL_USER = "Do not call any tools. Reply with exactly one word: ok";

const FOLLOW_1 = "Name one thing compaction invalidates.";
const FOLLOW_1_ASSISTANT = "The cached history prefix.";
const FOLLOW_2 = "Name the recovery cost.";

interface BaseConversation {
  /** system + body; the exact pre-compaction request. */
  all: ChatMessage[];
  /** body only (no system), used to build compacted variants. */
  body: ChatMessage[];
}

function buildBase(tag: string): BaseConversation {
  const body: ChatMessage[] = [];
  body.push({ role: "user", content: `Project brief:\n${briefCorpus(40)}` });
  for (let i = 0; i < TOOL_TURNS; i++) {
    body.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `call_${i}`,
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: `src/module-${i}.ts` }),
          },
        },
      ],
    });
    body.push({ role: "tool", tool_call_id: `call_${i}`, content: fileBlob(i) });
  }
  body.push({ role: "user", content: RECENT_USER });
  body.push({ role: "assistant", content: RECENT_ASSISTANT });
  body.push({ role: "user", content: FINAL_USER });
  return { all: [systemMessage(makeSystem(tag)), ...body], body };
}

/**
 * Deterministic extractive summary — no model call. Both placements get the
 * exact same string, so any `cached_tokens` difference is purely positional.
 */
function stubSummarize(middle: ChatMessage[]): string {
  const first = contentToText(middle[0]?.content ?? "");
  const last = contentToText(middle[middle.length - 1]?.content ?? "");
  return [
    `Earlier ${middle.length} messages folded into this summary.`,
    `The assistant inspected ${TOOL_TURNS} source modules with read_file; ` +
      `all raw file output has been dropped from the transcript.`,
    `First recalled: ${first.slice(0, 120)}`,
    `Last recalled: ${last.slice(0, 120)}`,
    `Key invariant under study: prefix caching is purely positional; ` +
      `append-only edits preserve it, in-place rewrites break it.`,
  ].join("\n");
}

const COMPACT_OPTIONS: CompactOptions = {
  keepRecent: KEEP_RECENT,
  keepLeading: KEEP_LEADING,
  summarize: stubSummarize,
};

/* ------------------------------------------------------------------- run */

interface CallSpec {
  label: string;
  messages: ChatMessage[];
}

interface Row {
  call: number;
  label: string;
  prompt: number;
  cached: number;
  cacheWrite: number;
  cost: number;
  finish: string;
}

interface CallOutcome {
  usage?: Usage;
  finish?: string;
  error?: string;
}

async function callOnce(
  spec: CallSpec,
  sessionId: string,
  attempt = 0,
): Promise<CallOutcome> {
  try {
    const result = await client.chatStream({
      model: MODEL,
      messages: spec.messages,
      tools: TOOLS,
      temperature: TEMPERATURE,
      maxTokens: MAX_TOKENS,
      sessionId,
    });
    return { usage: result.usage, finish: result.finishReason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retryable = /429|rate|temporar|timeout|ECONN|5\d\d/i.test(message);
    if (retryable && attempt < MAX_ATTEMPTS - 1) {
      await sleep(2000 * 2 ** attempt); // 2s, 4s
      return callOnce(spec, sessionId, attempt + 1);
    }
    return { error: message };
  }
}

async function runScenario(
  title: string,
  sessionId: string,
  specs: CallSpec[],
): Promise<Row[]> {
  console.log(`\n=== ${title} ===`);
  const rows: Row[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const outcome = await callOnce(spec, sessionId);
    const u = outcome.usage;
    rows.push({
      call: i + 1,
      label: spec.label,
      prompt: u?.prompt_tokens ?? 0,
      cached: u?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWrite: u?.prompt_tokens_details?.cache_write_tokens ?? 0,
      cost: u?.cost ?? 0,
      finish: outcome.error ? `error: ${outcome.error}` : (outcome.finish ?? "?"),
    });
    if (i < specs.length - 1) await sleep(CALL_DELAY_MS);
  }
  printTable(rows);
  return rows;
}

function pad(value: string, width: number, right = false): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

function printTable(rows: Row[]): void {
  const headers = ["#", "label", "prompt", "cached", "hit%", "cache_write", "cost($)", "finish"];
  const body = rows.map((r) => [
    String(r.call),
    r.label,
    String(r.prompt),
    String(r.cached),
    r.prompt > 0 ? ((r.cached / r.prompt) * 100).toFixed(1) : "0.0",
    String(r.cacheWrite),
    r.cost.toFixed(6),
    r.finish,
  ]);
  const widths = headers.map((h, c) =>
    Math.max(h.length, ...body.map((row) => row[c]!.length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, c) => pad(cell, widths[c]!, c !== 1)).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) console.log(line(row));
}

/* ------------------------------------------------------------- scenarios */

interface CompactScenario {
  base: BaseConversation;
  compacted: ChatMessage[];
  follow1: ChatMessage[];
  follow2: ChatMessage[];
  repacked: ChatMessage[];
}

async function buildCompactScenario(
  tag: string,
  placement: SummaryPlacement,
): Promise<CompactScenario> {
  const base = buildBase(tag);
  const opts: CompactOptions = { ...COMPACT_OPTIONS, placement };
  const compacted = (await compactDetailed(base.all, opts)).messages;
  const follow1 = [...compacted, { role: "user", content: FOLLOW_1 }];
  const follow2 = [
    ...follow1,
    { role: "assistant", content: FOLLOW_1_ASSISTANT },
    { role: "user", content: FOLLOW_2 },
  ];
  const repacked = (await compactDetailed(follow2, opts)).messages;
  return { base, compacted, follow1, follow2, repacked };
}

function compactSpecs(scenario: CompactScenario): CallSpec[] {
  return [
    { label: "pre#1", messages: scenario.base.all },
    { label: "pre#2", messages: scenario.base.all },
    { label: "compact#1", messages: scenario.compacted },
    { label: "compact#2", messages: scenario.compacted },
    { label: "follow#1", messages: scenario.follow1 },
    { label: "follow#2", messages: scenario.follow2 },
    { label: "repack#1", messages: scenario.repacked },
    { label: "repack#2", messages: scenario.repacked },
  ];
}

interface ClearScenario {
  base: BaseConversation;
  cleared: ChatMessage[];
  follow1: ChatMessage[];
}

function buildClearScenario(tag: string): ClearScenario {
  const base = buildBase(tag);
  const cleared = clearToolResultsDetailed(base.all, {
    keepLastN: CLEAR_KEEP_LAST,
  }).messages;
  const follow1 = [...cleared, { role: "user", content: FOLLOW_1 }];
  return { base, cleared, follow1 };
}

function clearSpecs(scenario: ClearScenario): CallSpec[] {
  return [
    { label: "pre#1", messages: scenario.base.all },
    { label: "pre#2", messages: scenario.base.all },
    { label: "clear#1", messages: scenario.cleared },
    { label: "clear#2", messages: scenario.cleared },
    { label: "follow#1", messages: scenario.follow1 },
  ];
}

/**
 * Isolated placement probe. The main scenarios warm a *long* prefix and then
 * truncate it, which (on this provider) misses regardless of placement. Here we
 * warm only the *shared* head `[system][leading]` and then send the two
 * compacted views, so the only variable is where the summary sits:
 *
 *   spliced  = [system][leading][summary][tail]   (shares system+leading)
 *   leading  = [system][summary][leading][tail]   (shares system only)
 *
 * `warm#2.cached` is the size of the whole shared head; the two compact calls
 * show how much of it each placement keeps.
 */
async function buildPlaceScenario(tag: string): Promise<{
  head: ChatMessage[];
  spliced: ChatMessage[];
  leading: ChatMessage[];
}> {
  const base = buildBase(tag);
  const system = base.all[0]!;
  const firstUser = base.body[0]!;
  const opts: CompactOptions = { ...COMPACT_OPTIONS, keepLeading: KEEP_LEADING };
  const spliced = (await compactDetailed(base.all, { ...opts, placement: "spliced" })).messages;
  const leading = (await compactDetailed(base.all, { ...opts, placement: "leading" })).messages;
  return { head: [system, firstUser], spliced, leading };
}

function placeSpecs(scenario: {
  head: ChatMessage[];
  spliced: ChatMessage[];
  leading: ChatMessage[];
}): CallSpec[] {
  return [
    { label: "warm#1", messages: scenario.head },
    { label: "warm#2", messages: scenario.head },
    { label: "splice#1", messages: scenario.spliced },
    { label: "lead#1", messages: scenario.leading },
  ];
}

/* --------------------------------------------------------------- reporting */

function rowByLabel(rows: Row[], label: string): Row | undefined {
  return rows.find((r) => r.label === label);
}

function printCurve(name: string, rows: Row[]): void {
  const pick = (label: string) => {
    const r = rowByLabel(rows, label);
    return r ? `${r.cached}@${label}` : `${label}=n/a`;
  };
  console.log(
    `\n${name.padEnd(10)} ` +
      `pre2=${rowByLabel(rows, "pre#2")?.cached ?? 0}  ` +
      `${pick("compact#1")}  ${pick("compact#2")}  ` +
      `${pick("follow#1")}  ${pick("follow#2")}  ` +
      `${pick("repack#1")}  ${pick("repack#2")}`,
  );
}

function printAccounting(
  label: string,
  pre: Row | undefined,
  after: Row | undefined,
  cached1: Row | undefined,
): void {
  const basePrompt = pre?.prompt ?? 0;
  const afterPrompt = after?.prompt ?? 0;
  const delta = basePrompt - afterPrompt;
  const pct = basePrompt > 0 ? (delta / basePrompt) * 100 : 0;
  console.log(
    `${label.padEnd(10)} prompt ${String(basePrompt).padStart(6)} -> ` +
      `${String(afterPrompt).padStart(6)}  (-${delta} tok, -${pct.toFixed(1)}%)  ` +
      `cached@call1=${cached1?.cached ?? 0}`,
  );
}

/* ------------------------------------------------------------- local selftest */

async function selftest(): Promise<void> {
  console.log("selftest — no API calls\n");
  const base = buildBase(`selftest@${SALT}`);
  console.log(
    `base: ${base.all.length} messages, est ${estimateTokens(
      base.all.map((m) => contentToText(m.content ?? "")).join("\n"),
    )} tok (system+body)`,
  );

  const spliced = await compactDetailed(base.all, {
    ...COMPACT_OPTIONS,
    placement: "spliced",
  });
  const leading = await compactDetailed(base.all, {
    ...COMPACT_OPTIONS,
    placement: "leading",
  });
  const cleared = clearToolResultsDetailed(base.all, {
    keepLastN: CLEAR_KEEP_LAST,
  });

  for (const [name, result] of [
    ["spliced", spliced],
    ["leading", leading],
  ] as const) {
    const problems = validateToolTranscript(result.messages);
    console.log(
      `${name.padEnd(8)} ${result.messages.length} messages, ` +
        `summarized=${result.summarized} summaryIndex=${result.summaryIndex}, ` +
        `valid=${problems.length === 0}`,
    );
    if (problems.length > 0) console.log(`  problems: ${problems.join("; ")}`);
  }
  console.log(
    `cleared  ${cleared.messages.length} messages, cleared=${cleared.cleared} ` +
      `kept=${cleared.kept} charsSaved=${cleared.charsSaved} ` +
      `estTokSaved=${cleared.estimatedTokensSaved}, ` +
      `valid=${validateToolTranscript(cleared.messages).length === 0}`,
  );

  // Structural invariants that must hold regardless of placement.
  const assert = (cond: boolean, message: string) => {
    if (!cond) throw new Error(`selftest failed: ${message}`);
  };
  assert(
    validateToolTranscript(cleared.messages).length === 0,
    "clearToolResults must preserve the tool-call envelope",
  );
  const firstTool = cleared.messages.find((m) => m.role === "tool");
  assert(
    firstTool?.role === "tool" && firstTool.content !== fileBlob(0),
    "old tool content should be replaced",
  );
  const lastTool = [...cleared.messages].reverse().find((m) => m.role === "tool");
  assert(
    lastTool?.role === "tool" && lastTool.content.includes("deterministic stale"),
    "the last N tool results should be kept verbatim",
  );
  assert(
    spliced.messages[2]?.role === "user" &&
      contentToText(spliced.messages[2]?.content ?? "").includes("[conversation-summary]"),
    "spliced summary should sit after the retained leading message",
  );
  assert(
    leading.messages[1]?.role === "user" &&
      contentToText(leading.messages[1]?.content ?? "").includes("[conversation-summary]"),
    "leading summary should sit right after system",
  );
  console.log("\nselftest OK — transcripts valid, placements distinct.");
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<void> {
  console.log(`compaction-experiment — model=${MODEL} salt=${SALT}`);
  console.log("cached = usage.prompt_tokens_details.cached_tokens (real, per call)");
  console.log(
    `tools (${TOOLS.length}): ${TOOLS.map((t) => t.function.name).join(", ")}`,
  );

  const requested = process.argv
    .slice(2)
    .filter((a) => !a.startsWith("--"));
  const select = (name: string) =>
    requested.length === 0 || requested.includes(name);

  if (select("selftest")) {
    await selftest();
    if (requested.length > 0) return;
  }

  const results: Record<string, Row[]> = {};

  if (select("spliced")) {
    const scenario = await buildCompactScenario(`spliced@${SALT}`, "spliced");
    results.spliced = await runScenario(
      "spliced — summary replaces the summarized span in place",
      "m3-spliced",
      compactSpecs(scenario),
    );
  }

  if (select("leading")) {
    const scenario = await buildCompactScenario(`leading@${SALT}`, "leading");
    results.leading = await runScenario(
      "leading — summary pinned right after system",
      "m3-leading",
      compactSpecs(scenario),
    );
  }

  if (select("clear")) {
    const scenario = buildClearScenario(`clear@${SALT}`);
    results.clear = await runScenario(
      "clear — empty old tool-result bodies, keep envelopes",
      "m3-clear",
      clearSpecs(scenario),
    );
  }

  if (select("place")) {
    const scenario = await buildPlaceScenario(`place@${SALT}`);
    results.place = await runScenario(
      "place — warm only [system][leading], then compare summary slots",
      "m3-place",
      placeSpecs(scenario),
    );
    const warm = rowByLabel(results.place, "warm#2")?.cached ?? 0;
    const splice = rowByLabel(results.place, "splice#1")?.cached ?? 0;
    const lead = rowByLabel(results.place, "lead#1")?.cached ?? 0;
    console.log(
      `\nplacement isolation: warm head cached=${warm}  ` +
        `spliced#1 cached=${splice} (keeps ${splice})  ` +
        `leading#1 cached=${lead} (keeps ${lead})  ` +
        `Δ=${splice - lead}`,
    );
  }

  console.log("\n=== recovery curves (cached tokens per call) ===");
  for (const [name, rows] of Object.entries(results)) printCurve(name, rows);

  console.log("\n=== token accounting (provider prompt_tokens) ===");
  if (results.spliced) {
    printAccounting(
      "compact",
      rowByLabel(results.spliced, "pre#2"),
      rowByLabel(results.spliced, "compact#2"),
      rowByLabel(results.spliced, "compact#1"),
    );
  }
  if (results.clear) {
    printAccounting(
      "clear",
      rowByLabel(results.clear, "pre#2"),
      rowByLabel(results.clear, "clear#2"),
      rowByLabel(results.clear, "clear#1"),
    );
  }
  if (results.spliced && results.leading) {
    const s1 = rowByLabel(results.spliced, "compact#1")?.cached ?? 0;
    const l1 = rowByLabel(results.leading, "compact#1")?.cached ?? 0;
    console.log(
      `\nplacement gap at compact#1: spliced cached=${s1} vs leading cached=${l1} ` +
        `(+${s1 - l1} for splicing the summary into history)`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
