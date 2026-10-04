/**
 * M11 — lazy tool exposure experiment (tool search / code-mode facade).
 *
 * Run with:
 *   pnpm --filter @agent/server exec tsx scripts/tool-search-experiment.ts --salt=m11a
 *   pnpm --filter @agent/server exec tsx scripts/tool-search-experiment.ts --index-only
 *   pnpm --filter @agent/server exec tsx scripts/tool-search-experiment.ts --only=probe
 *
 * The question (MECHANISMS §3, runs m4-mcp.md): eager schema injection puts all
 * N tool schemas in the request prefix on every call. Lazy exposure replaces
 * them with a two-tool facade (`tool_search` + `tool_call`) and loads a tool's
 * schema on demand. This harness measures the difference for real:
 *
 *   1. `--index-only` — determinism proof: the `ToolIndex` ranks identically
 *      whether the tools are fed in original or reversed order (no API calls).
 *   2. probe — the *same* system + user, three identical calls per mode; only
 *      the `tools` array differs (eager N schemas vs the 2 facade schemas).
 *      Reports `prompt_tokens`, `cached_tokens`, `hit%`, cost per call.
 *   3. task — the *same* task run end-to-end by a real `Agent` in both modes:
 *      eager (`ToolRegistry` of all N tools) vs lazy (only the facade). Reports
 *      per-call usage, total tokens/cost, and whether the task completes.
 *
 * Real `usage` only: `usage.prompt_tokens` and
 * `usage.prompt_tokens_details.cached_tokens`. Opens OpenRouter directly (no
 * HTTP server), so the only thing that varies is the request body. Bounded to
 * <= 30 API calls; on HTTP 429 back off and retry.
 */

import {
  Agent,
  OpenRouterClient,
  ToolRegistry,
  builtinTools,
  withCacheBreakpoint,
  type ChatMessage,
  type ToolDef,
  type ToolSchema,
  type Usage,
} from "@agent/core";
import {
  ToolIndex,
  createToolSearchRegistry,
} from "../../core/src/mechanisms/tool-search/index.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const client = new OpenRouterClient({
  apiKey: config.apiKey,
  referer: config.referer,
  title: config.title,
});

/** Fixed by the brief; do not read `OPENROUTER_MODEL` here. */
const MODEL = "xiaomi/mimo-v2.6-flash";
const TEMPERATURE = 0;
const MAX_STEPS = 8;
const CALL_DELAY_MS = 500;
const MAX_API_CALLS = 30;
const MAX_ATTEMPTS = 3;
const CWD = config.repoRoot;

const SALT =
  process.argv.find((a) => a.startsWith("--salt="))?.slice("--salt=".length) ||
  Date.now().toString(36);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let apiCalls = 0;

/* --------------------------------------------------------------- fixtures */

/** Long deterministic corpus: pushes the stable prefix past the cache minimum. */
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

function makeSystem(tag: string): string {
  return [
    `You are a minimal coding agent running tool-search experiment "${tag}@${SALT}".`,
    "Sentinel: SENTINEL-M11-AAAA.",
    "",
    stableCorpus(90),
  ].join("\n");
}

function systemMessage(text: string): ChatMessage {
  return { role: "system", content: withCacheBreakpoint(text) };
}

const json = (value: unknown): string => JSON.stringify(value);

/** Tiny deterministic FNV-1a hex digest (stand-in for a hash tool). */
function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function asString(input: Record<string, unknown>, key: string): string {
  return typeof input[key] === "string" ? (input[key] as string) : "";
}

/** Build a read-only stand-in tool with a fixed signature. */
function fixture(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  run: (input: Record<string, unknown>) => string,
): ToolDef {
  return {
    name,
    description,
    readOnly: true,
    parameters: { type: "object", properties, required },
    async execute(input) {
      return { output: run(input) };
    },
  };
}

const TEXT_PROP = { text: { type: "string", description: "Input text." } };

/**
 * Stand-ins for MCP-like tools: a mix of text utilities and "remote service"
 * tools. They are pure and deterministic so both modes get identical outputs.
 */
function fixtureTools(): ToolDef[] {
  return [
    fixture(
      "word_count",
      "Count the number of words and characters in a text payload. Useful for length checks, summaries, and readability checks.",
      TEXT_PROP,
      ["text"],
      (i) => {
        const text = asString(i, "text");
        const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
        return json({ words, characters: text.length });
      },
    ),
    fixture(
      "reverse_string",
      "Reverse the characters of a string. Input 'agent' returns 'tnega'.",
      TEXT_PROP,
      ["text"],
      (i) => json({ reversed: [...asString(i, "text")].reverse().join("") }),
    ),
    fixture(
      "uppercase_text",
      "Convert a text payload to uppercase.",
      TEXT_PROP,
      ["text"],
      (i) => json({ text: asString(i, "text").toUpperCase() }),
    ),
    fixture(
      "base64_encode",
      "Encode a UTF-8 text payload as base64.",
      TEXT_PROP,
      ["text"],
      (i) => json({ base64: Buffer.from(asString(i, "text"), "utf8").toString("base64") }),
    ),
    fixture(
      "base64_decode",
      "Decode a base64 payload back to UTF-8 text.",
      TEXT_PROP,
      ["text"],
      (i) => json({ text: Buffer.from(asString(i, "text"), "base64").toString("utf8") }),
    ),
    fixture(
      "checksum_hex",
      "Compute a short deterministic hex checksum of a text payload.",
      TEXT_PROP,
      ["text"],
      (i) => json({ checksum: fnv1aHex(asString(i, "text")) }),
    ),
    fixture(
      "slugify",
      "Turn a title into a URL-safe slug (lowercase, dashes).",
      TEXT_PROP,
      ["text"],
      (i) =>
        json({
          slug: asString(i, "text")
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, ""),
        }),
    ),
    fixture(
      "url_encode",
      "Percent-encode a text payload for use in a URL query.",
      TEXT_PROP,
      ["text"],
      (i) => json({ encoded: encodeURIComponent(asString(i, "text")) }),
    ),
    fixture(
      "html_escape",
      "Escape HTML special characters in a text payload.",
      TEXT_PROP,
      ["text"],
      (i) =>
        json({
          escaped: asString(i, "text")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;"),
        }),
    ),
    fixture(
      "title_case",
      "Capitalize the first letter of each word in a text payload.",
      TEXT_PROP,
      ["text"],
      (i) =>
        json({
          text: asString(i, "text").replace(/\b\w/g, (c) => c.toUpperCase()),
        }),
    ),
    fixture(
      "truncate_text",
      "Truncate a text payload to a maximum length, appending an ellipsis.",
      {
        text: { type: "string" },
        length: { type: "integer", description: "Maximum characters to keep." },
      },
      ["text", "length"],
      (i) => {
        const text = asString(i, "text");
        const length = typeof i["length"] === "number" ? i["length"] : 20;
        return json({ text: text.length <= length ? text : `${text.slice(0, length)}...` });
      },
    ),
    fixture(
      "word_frequency",
      "Report how many times each word occurs in a text payload.",
      TEXT_PROP,
      ["text"],
      (i) => {
        const counts: Record<string, number> = {};
        for (const word of asString(i, "text").toLowerCase().split(/\s+/)) {
          if (word === "") continue;
          counts[word] = (counts[word] ?? 0) + 1;
        }
        return json(counts);
      },
    ),
    fixture(
      "levenshtein_distance",
      "Compute the edit distance between two strings.",
      { a: { type: "string" }, b: { type: "string" } },
      ["a", "b"],
      (i) => {
        const a = asString(i, "a");
        const b = asString(i, "b");
        const dp = Array.from({ length: a.length + 1 }, (_, r) =>
          Array.from({ length: b.length + 1 }, (_, c) => (r === 0 ? c : c === 0 ? r : 0)),
        );
        for (let r = 1; r <= a.length; r++) {
          for (let c = 1; c <= b.length; c++) {
            const cost = a[r - 1] === b[c - 1] ? 0 : 1;
            const row = dp[r]!;
            row[c] = Math.min(dp[r - 1]![c]! + 1, row[c - 1]! + 1, dp[r - 1]![c - 1]! + cost);
          }
        }
        return json({ distance: dp[a.length]![b.length]! });
      },
    ),
    fixture(
      "caesar_cipher",
      "Shift each letter of a text payload by a fixed number of positions.",
      { text: { type: "string" }, shift: { type: "integer" } },
      ["text", "shift"],
      (i) => {
        const shift = typeof i["shift"] === "number" ? i["shift"] : 1;
        const out = [...asString(i, "text")]
          .map((ch) => {
            const code = ch.charCodeAt(0);
            if (code >= 97 && code <= 122) {
              return String.fromCharCode(((code - 97 + shift) % 26 + 26) % 26 + 97);
            }
            return ch;
          })
          .join("");
        return json({ text: out });
      },
    ),
    fixture(
      "weather_current",
      "Fetch the current weather for a city from a remote weather service.",
      { city: { type: "string", description: "City name." } },
      ["city"],
      (i) => json({ city: asString(i, "city"), temperature_c: 21, conditions: "clear" }),
    ),
    fixture(
      "translation_translate",
      "Translate a text payload into a target language via a remote service.",
      {
        text: { type: "string" },
        target: { type: "string", description: "Target language code." },
      },
      ["text", "target"],
      (i) => json({ text: asString(i, "text"), target: asString(i, "target"), translation: "(fixture)" }),
    ),
    fixture(
      "currency_convert",
      "Convert an amount between two currencies using a remote rate table.",
      {
        amount: { type: "number" },
        from: { type: "string" },
        to: { type: "string" },
      },
      ["amount", "from", "to"],
      (i) => json({ amount: i["amount"] ?? 0, from: asString(i, "from"), to: asString(i, "to"), result: i["amount"] ?? 0 }),
    ),
    fixture(
      "calendar_list_events",
      "List upcoming calendar events for a given day from a remote calendar.",
      { date: { type: "string", description: "ISO date (YYYY-MM-DD)." } },
      ["date"],
      (i) => json({ date: asString(i, "date"), events: [] }),
    ),
    fixture(
      "json_format",
      "Pretty-print a JSON string with two-space indentation.",
      { text: { type: "string" } },
      ["text"],
      (i) => {
        try {
          return json({ formatted: JSON.stringify(JSON.parse(asString(i, "text")), null, 2) });
        } catch {
          return json({ error: "invalid JSON" });
        }
      },
    ),
    fixture(
      "csv_parse",
      "Parse a small CSV payload into rows of fields.",
      { text: { type: "string" } },
      ["text"],
      (i) => json({ rows: asString(i, "text").split(/\r?\n/).filter(Boolean).map((r) => r.split(",")) }),
    ),
  ];
}

/** The full real tool set: the builtins plus the MCP-like stand-ins. */
const REAL_TOOLS: ToolDef[] = [...builtinTools(), ...fixtureTools()];
const N = REAL_TOOLS.length;

function buildRegistry(tools: ToolDef[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

/** Eager schemas: all N real tools. */
function eagerSchemas(): ToolSchema[] {
  return buildRegistry(REAL_TOOLS).schemas();
}

/** Lazy schemas: only the two facade tools. */
function lazySchemas(): ToolSchema[] {
  return createToolSearchRegistry(REAL_TOOLS).schemas();
}

const USER_READY = "Reply with exactly one word: ok";

/** The one task both modes must complete, unchanged. */
const TASK = [
  "Complete two subtasks using the tools available to you.",
  "",
  '1. Count the number of words in this text: "the quick brown fox jumps over the lazy dog".',
  '2. Reverse the characters in the string "agent".',
  "",
  "If you are unsure which tool to use, search the available tools first, then call the matching tool.",
  "",
  "When done, reply on a single line exactly as:",
  "words=<count> reversed=<reversed string>",
].join("\n");

/* ------------------------------------------------------------------- run */

interface CallSpec {
  label: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
}

interface Row {
  call: number;
  label: string;
  prompt: number;
  completion: number;
  cached: number;
  cacheWrite: number;
  cost: number;
  finish: string;
}

function is429(text: string | undefined): boolean {
  if (!text) return false;
  return /\b429\b|rate.?limit/i.test(text);
}

async function callOnce(
  spec: CallSpec,
  sessionId: string,
  attempt = 0,
): Promise<{ usage?: Usage; finish?: string; error?: string }> {
  if (apiCalls >= MAX_API_CALLS) {
    return { error: `API call budget (${MAX_API_CALLS}) exhausted` };
  }
  apiCalls++;
  try {
    const result = await client.chatStream({
      model: MODEL,
      messages: spec.messages,
      tools: spec.tools,
      temperature: TEMPERATURE,
      maxTokens: 16,
      sessionId,
    });
    return { usage: result.usage, finish: result.finishReason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (attempt < MAX_ATTEMPTS - 1 && is429(message)) {
      await sleep(3000 * (attempt + 1));
      return callOnce(spec, sessionId, attempt + 1);
    }
    return { error: message };
  }
}

async function runProbe(
  name: string,
  sessionId: string,
  tools: ToolSchema[],
): Promise<Row[]> {
  const system = makeSystem(name);
  const specs: CallSpec[] = [1, 2, 3].map((n) => ({
    label: `${name}#${n}`,
    messages: [systemMessage(system), { role: "user", content: USER_READY }],
    tools,
  }));
  const rows: Row[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const r = await callOnce(spec, sessionId);
    const u = r.usage;
    rows.push({
      call: i + 1,
      label: spec.label,
      prompt: u?.prompt_tokens ?? 0,
      completion: u?.completion_tokens ?? 0,
      cached: u?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWrite: u?.prompt_tokens_details?.cache_write_tokens ?? 0,
      cost: u?.cost ?? 0,
      finish: r.error ? `error: ${r.error}` : (r.finish ?? "?"),
    });
    if (i < specs.length - 1) await sleep(CALL_DELAY_MS);
  }
  printTable(`${name} — ${tools.length} tool schema(s)`, rows);
  return rows;
}

interface AgentRun {
  mode: string;
  tools: string[];
  usages: Usage[];
  finalText: string;
  toolCalls: { name: string; input: unknown; output: string; isError: boolean }[];
  turnError?: string;
}

async function runTaskOnce(mode: string): Promise<AgentRun> {
  const registry =
    mode === "eager"
      ? buildRegistry(REAL_TOOLS)
      : createToolSearchRegistry(REAL_TOOLS);
  const agent = new Agent(
    {
      client,
      model: MODEL,
      tools: registry,
      cwd: CWD,
      permissionMode: "yolo",
      maxSteps: MAX_STEPS,
      temperature: TEMPERATURE,
    },
    `m11-${mode}-${SALT}`,
  );

  const usages: Usage[] = [];
  const calls = new Map<string, { name: string; input: unknown; output: string; isError: boolean }>();
  let finalText = "";
  let turnError: string | undefined;

  for await (const event of agent.run(TASK)) {
    switch (event.type) {
      case "usage":
        apiCalls++;
        usages.push(event.usage);
        break;
      case "assistant.message":
        if (
          typeof event.message.content === "string" &&
          event.message.content.trim().length > 0
        ) {
          finalText = event.message.content;
        }
        break;
      case "tool.call":
        calls.set(event.toolCallId, { name: event.name, input: event.input, output: "", isError: false });
        break;
      case "tool.result": {
        const entry = calls.get(event.toolCallId);
        if (entry) {
          entry.output = event.output;
          entry.isError = event.isError;
        }
        break;
      }
      case "turn.end":
        if (event.reason === "error") turnError = event.error;
        break;
      default:
        break;
    }
  }

  return {
    mode,
    tools: registry.list().map((t) => t.name),
    usages,
    finalText,
    toolCalls: [...calls.values()],
    turnError,
  };
}

async function runTask(mode: string): Promise<AgentRun> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const run = await runTaskOnce(mode);
    if (!is429(run.turnError)) return run;
    const wait = 3000 * (attempt + 1);
    console.warn(`  [429] ${mode}: backing off ${wait}ms (attempt ${attempt + 1})`);
    await sleep(wait);
  }
  throw new Error(`${mode}: still rate-limited after ${MAX_ATTEMPTS} attempts`);
}

/* --------------------------------------------------------------- reporting */

function pad(value: string, width: number, right = false): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

function printTable(title: string, rows: Row[]): void {
  console.log(`\n=== ${title} ===`);
  const headers = ["#", "label", "prompt", "cached", "cache_write", "hit%", "cost($)", "finish"];
  const body = rows.map((r) => [
    String(r.call),
    r.label,
    String(r.prompt),
    String(r.cached),
    String(r.cacheWrite),
    r.prompt > 0 ? ((r.cached / r.prompt) * 100).toFixed(1) : "0.0",
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

interface UsageTotals {
  prompt: number;
  completion: number;
  cached: number;
  total: number;
  cost: number;
  calls: number;
}

function totals(usages: Usage[]): UsageTotals {
  const t: UsageTotals = { prompt: 0, completion: 0, cached: 0, total: 0, cost: 0, calls: usages.length };
  for (const u of usages) {
    t.prompt += u.prompt_tokens ?? 0;
    t.completion += u.completion_tokens ?? 0;
    t.cached += u.prompt_tokens_details?.cached_tokens ?? 0;
    t.total += u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
    t.cost += u.cost ?? 0;
  }
  return t;
}

function printAgentRun(run: AgentRun): void {
  console.log(`\n=== task (${run.mode}) — ${run.tools.length} registered tool(s) ===`);
  console.log(`registered: ${run.tools.join(", ")}`);
  const rows: Row[] = run.usages.map((u, i) => ({
    call: i + 1,
    label: `${run.mode}#${i + 1}`,
    prompt: u.prompt_tokens ?? 0,
    completion: u.completion_tokens ?? 0,
    cached: u.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWrite: u.prompt_tokens_details?.cache_write_tokens ?? 0,
    cost: u.cost ?? 0,
    finish: "?",
  }));
  printTable("per-call usage", rows);
  if (run.toolCalls.length === 0) {
    console.log("tool calls: (none)");
  } else {
    console.log("tool calls:");
    for (const call of run.toolCalls) {
      console.log(
        `  - ${call.name}(${JSON.stringify(call.input)}) -> ${call.output.replace(/\s+/g, " ").slice(0, 120)}${call.isError ? " [error]" : ""}`,
      );
    }
  }
  if (run.turnError) console.log(`turn error: ${run.turnError}`);
  const t = totals(run.usages);
  console.log(
    `TOTALS prompt=${t.prompt} completion=${t.completion} cached=${t.cached} ` +
      `total=${t.total} cost=$${t.cost.toFixed(6)} calls=${t.calls}`,
  );
  console.log(`final answer: ${run.finalText.replace(/\s+/g, " ").slice(0, 200)}`);
  console.log(`task completed: ${taskCompleted(run.finalText) ? "yes" : "no"}`);
}

function taskCompleted(text: string): boolean {
  return /\b9\b/.test(text) && /tnega/i.test(text);
}

/* ------------------------------------------------------------ index proof */

function proveIndexDeterminism(): void {
  console.log("\n=== part 1 — ToolIndex determinism (no API calls) ===");
  const queries = ["count words", "reverse a string", "weather in a city", "word", "base64"];
  const forward = new ToolIndex(REAL_TOOLS);
  const reversed = new ToolIndex([...REAL_TOOLS].reverse());

  const sameEntries =
    JSON.stringify(forward.entries()) === JSON.stringify(reversed.entries());
  console.log(`entries() identical for original vs reversed input: ${sameEntries ? "PASS" : "FAIL"}`);

  let allSame = sameEntries;
  for (const query of queries) {
    const a = forward.search(query, 5);
    const b = reversed.search(query, 5);
    const same = JSON.stringify(a) === JSON.stringify(b);
    allSame = allSame && same;
    console.log(
      `search(${JSON.stringify(query)}) -> ${a.map((m) => `${m.name}(${m.score})`).join(", ")}  [${same ? "stable" : "UNSTABLE"}]`,
    );
  }
  console.log(`determinism: ${allSame ? "PASS" : "FAIL"}`);
  console.log(`index size: ${forward.size()} tools`);
  console.log(`facade tools: ${createToolSearchRegistry(REAL_TOOLS).list().map((t) => t.name).join(", ")}`);
  console.log(`facade signature sample: ${forward.entries().find((e) => e.name === "word_count")?.signature ?? "?"}`);
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<void> {
  console.log(`tool-search-experiment — model=${MODEL} salt=${SALT}`);
  console.log(`real tools N=${N} (builtins + MCP-like stand-ins)`);
  console.log(`eager schemas=${eagerSchemas().length}  lazy schemas=${lazySchemas().length}`);

  proveIndexDeterminism();

  if (process.argv.includes("--index-only")) {
    console.log("\n(--index-only: skipping OpenRouter measurements)");
    return;
  }

  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const selected = onlyArg
    ? new Set(onlyArg.slice("--only=".length).split(",").map((s) => s.trim()))
    : undefined;
  const wants = (part: string) => selected === undefined || selected.has(part);

  const eagerProbe = wants("probe")
    ? await runProbe("eager-probe", "m11-eager-probe", eagerSchemas())
    : [];
  const lazyProbe = wants("probe")
    ? await runProbe("lazy-probe", "m11-lazy-probe", lazySchemas())
    : [];

  const eagerTask = wants("task") ? await runTask("eager") : undefined;
  if (eagerTask) printAgentRun(eagerTask);
  const lazyTask = wants("task") ? await runTask("lazy") : undefined;
  if (lazyTask) printAgentRun(lazyTask);

  console.log("\n=== summary ===");
  const warm = (rows: Row[]): Row | undefined => rows[rows.length - 1];
  const eagerWarm = warm(eagerProbe);
  const lazyWarm = warm(lazyProbe);
  if (eagerWarm && lazyWarm) {
    const saved = eagerWarm.prompt - lazyWarm.prompt;
    console.log(
      `prefix (warm call 3): eager prompt=${eagerWarm.prompt} (cached ${eagerWarm.cached}) ` +
        `vs lazy prompt=${lazyWarm.prompt} (cached ${lazyWarm.cached})`,
    );
    console.log(
      `prefix saving: ${saved} token (${((saved / eagerWarm.prompt) * 100).toFixed(1)}% smaller); ` +
        `eager hit%=${((eagerWarm.cached / eagerWarm.prompt) * 100).toFixed(1)} ` +
        `lazy hit%=${((lazyWarm.cached / lazyWarm.prompt) * 100).toFixed(1)}`,
    );
  }
  if (eagerTask && lazyTask) {
    const et = totals(eagerTask.usages);
    const lt = totals(lazyTask.usages);
    console.log(
      `task: eager calls=${et.calls} total=${et.total} cost=$${et.cost.toFixed(6)} completed=${taskCompleted(eagerTask.finalText)}  |  ` +
        `lazy calls=${lt.calls} total=${lt.total} cost=$${lt.cost.toFixed(6)} completed=${taskCompleted(lazyTask.finalText)}`,
    );
  }
  console.log(`total OpenRouter API calls: ${apiCalls} (ceiling ${MAX_API_CALLS})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
