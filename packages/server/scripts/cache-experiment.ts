/**
 * M1 cache & token-economics experiment harness.
 *
 * Run with:
 *   pnpm --filter @agent/server exec tsx scripts/cache-experiment.ts
 *
 * It talks to OpenRouter through `OpenRouterClient` from `@agent/core` directly
 * (no HTTP server in the loop), so the *only* thing that varies between calls
 * inside one experiment is the request body we deliberately change. For every
 * call it prints the real `usage.prompt_tokens_details.cached_tokens` /
 * `cache_write_tokens` numbers the provider reported.
 *
 * Experiments (see docs/MECHANISMS.md §2–§3 / §6):
 *   baseline     identical request x4           -> does cached climb?
 *   tool-order   same content, tools reversed   -> does order break the cache?
 *   tool-set     add one tool to the array       -> does membership break it?
 *   system       flip one byte of the system      -> how much of the prefix dies?
 *   append       grow the message array by appending only -> the healthy case
 *
 * Pass experiment names as argv to run a subset, e.g.
 *   tsx scripts/cache-experiment.ts baseline system
 *
 * Each invocation mixes a random salt into every system prompt, so a fresh run
 * never inherits cache hits from a previous run (the provider keeps entries
 * warm for minutes). Pass `--salt=<value>` to pin it for a controlled replay.
 */

import {
  OpenRouterClient,
  ToolRegistry,
  builtinTools,
  withCacheBreakpoint,
  type ChatMessage,
  type ToolSchema,
  type Usage,
} from "@agent/core";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const client = new OpenRouterClient({
  apiKey: config.apiKey,
  referer: config.referer,
  title: config.title,
});

const MODEL = config.model;
const TEMPERATURE = 0;
const MAX_TOKENS = 16;
/** Let the provider's cache settle between calls; avoids racing the write. */
const CALL_DELAY_MS = 500;

/**
 * Random per invocation, so repeated runs start from cold prefixes instead of
 * hitting entries a previous run left warm (they survive for minutes).
 */
const SALT =
  process.argv.find((a) => a.startsWith("--salt="))?.slice("--salt=".length) ||
  Date.now().toString(36);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- fixtures */

/**
 * A long, deterministic, human-readable corpus. It only exists to push the
 * stable prefix past the provider's minimum cacheable block (≈1024 tokens) so
 * the cache is actually exercised.
 */
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

const SENTINEL = "SENTINEL-AAAA";

/** Build a deterministic system prompt tagged so experiments do not collide. */
function makeSystem(tag: string, sentinel: string = SENTINEL): string {
  return [
    `You are a minimal coding agent running cache experiment "${tag}@${SALT}".`,
    `Sentinel: ${sentinel}.`,
    "Operation policy follows.",
    "",
    stableCorpus(90),
  ].join("\n");
}

function baseToolSchemas(): ToolSchema[] {
  const registry = new ToolRegistry();
  for (const tool of builtinTools()) registry.register(tool);
  return registry.schemas();
}

/** The real builtin tool set, in the deterministic order ToolRegistry.list() sorts to. */
const BASE_TOOLS = baseToolSchemas();

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

const USER_OK = "Reply with exactly one word: ok";

function systemMessage(text: string): ChatMessage {
  return { role: "system", content: withCacheBreakpoint(text) };
}

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

async function callOnce(
  spec: CallSpec,
  sessionId: string,
  attempt = 0,
): Promise<{ usage?: Usage; finish?: string; error?: string }> {
  try {
    const result = await client.chatStream({
      model: MODEL,
      messages: spec.messages,
      tools: spec.tools,
      temperature: TEMPERATURE,
      maxTokens: MAX_TOKENS,
      sessionId,
    });
    return { usage: result.usage, finish: result.finishReason };
  } catch (err) {
    if (attempt < 2) {
      await sleep(1500 * (attempt + 1));
      return callOnce(spec, sessionId, attempt + 1);
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function runExperiment(
  name: string,
  sessionId: string,
  specs: CallSpec[],
): Promise<Row[]> {
  console.log(`\n=== ${name} ===`);
  const rows: Row[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const r = await callOnce(spec, sessionId);
    const u = r.usage;
    const row: Row = {
      call: i + 1,
      label: spec.label,
      prompt: u?.prompt_tokens ?? 0,
      completion: u?.completion_tokens ?? 0,
      cached: u?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWrite: u?.prompt_tokens_details?.cache_write_tokens ?? 0,
      cost: u?.cost ?? 0,
      finish: r.error ? `error: ${r.error}` : (r.finish ?? "?"),
    };
    rows.push(row);
    if (i < specs.length - 1) await sleep(CALL_DELAY_MS);
  }
  printTable(rows);
  return rows;
}

function pad(value: string, width: number, right = false): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

function printTable(rows: Row[]): void {
  const headers = [
    "#",
    "label",
    "prompt",
    "cached",
    "cache_write",
    "hit%",
    "cost($)",
    "finish",
  ];
  const body = rows.map((r) => [
    String(r.call),
    r.label,
    String(r.prompt),
    String(r.cached),
    String(r.cacheWrite),
    r.prompt > 0 ? `${((r.cached / r.prompt) * 100).toFixed(1)}` : "0.0",
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

function baselineSpecs(): CallSpec[] {
  const system = makeSystem("baseline");
  const tools = BASE_TOOLS;
  return Array.from({ length: 4 }, (_, i): CallSpec => ({
    label: `identical#${i + 1}`,
    messages: [systemMessage(system), { role: "user", content: USER_OK }],
    tools,
  }));
}

function toolOrderSpecs(): CallSpec[] {
  const system = makeSystem("tool-order");
  const normal = BASE_TOOLS;
  const reversed = [...BASE_TOOLS].reverse();
  const mk = (label: string, tools: ToolSchema[]): CallSpec => ({
    label,
    messages: [systemMessage(system), { role: "user", content: USER_OK }],
    tools,
  });
  return [
    mk("normal#1", normal),
    mk("normal#2", normal),
    mk("reversed#1", reversed),
    mk("reversed#2", reversed),
    mk("normal#3", normal),
  ];
}

function toolSetSpecs(): CallSpec[] {
  const system = makeSystem("tool-set");
  const withExtra = [...BASE_TOOLS, EXTRA_TOOL];
  const mk = (label: string, tools: ToolSchema[]): CallSpec => ({
    label,
    messages: [systemMessage(system), { role: "user", content: USER_OK }],
    tools,
  });
  return [
    mk("base#1", BASE_TOOLS),
    mk("base#2", BASE_TOOLS),
    mk("base+extra#1", withExtra),
    mk("base+extra#2", withExtra),
    mk("base#3", BASE_TOOLS),
  ];
}

function systemSpecs(): CallSpec[] {
  const base = makeSystem("system", SENTINEL);
  const changed = makeSystem("system", "SENTINEL-AAAB"); // one byte flipped
  const mk = (label: string, system: string): CallSpec => ({
    label,
    messages: [systemMessage(system), { role: "user", content: USER_OK }],
    tools: BASE_TOOLS,
  });
  return [
    mk("base#1", base),
    mk("base#2", base),
    mk("changed#1", changed),
    mk("changed#2", changed),
    mk("base#3", base),
  ];
}

function appendSpecs(): CallSpec[] {
  const system = makeSystem("append");
  const prefixes: ChatMessage[] = [];
  const turns: Array<{ user: string; assistant: string }> = [
    { user: "Name one rule for keeping a prompt cache warm.", assistant: "Append only." },
    { user: "Name one thing that invalidates it.", assistant: "Rewriting the prefix." },
    { user: "Name the cheapest place to add context.", assistant: "The tail." },
    { user: "Name the property we protect.", assistant: "Prefix stability." },
  ];
  const specs: CallSpec[] = [];
  let index = 0;
  // call 1 starts with one user message; each later call appends a full turn.
  specs.push({
    label: "grow#1",
    messages: [systemMessage(system), { role: "user", content: turns[0]!.user }],
    tools: BASE_TOOLS,
  });
  for (index = 1; index < turns.length; index++) {
    const turn = turns[index]!;
    prefixes.push({ role: "user", content: turns[index - 1]!.user });
    prefixes.push({ role: "assistant", content: turns[index - 1]!.assistant });
    specs.push({
      label: `grow#${index + 1}`,
      messages: [
        systemMessage(system),
        ...prefixes,
        { role: "user", content: turn.user },
      ],
      tools: BASE_TOOLS,
    });
  }
  return specs;
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<void> {
  console.log(`cache-experiment — model=${MODEL}`);
  console.log(
    "cached = usage.prompt_tokens_details.cached_tokens (real, per call)",
  );

  const requested = process.argv
    .slice(2)
    .filter((a) => !a.startsWith("--"));
  const select = (name: string) =>
    requested.length === 0 || requested.includes(name);

  const results: Record<string, Row[]> = {};
  if (select("baseline"))
    results.baseline = await runExperiment(
      "baseline — identical request x4",
      "m1-baseline",
      baselineSpecs(),
    );
  if (select("tool-order"))
    results["tool-order"] = await runExperiment(
      "tool-order — reverse the tools array",
      "m1-tool-order",
      toolOrderSpecs(),
    );
  if (select("tool-set"))
    results["tool-set"] = await runExperiment(
      "tool-set — add one extra tool",
      "m1-tool-set",
      toolSetSpecs(),
    );
  if (select("system"))
    results.system = await runExperiment(
      "system — flip one byte of the system message",
      "m1-system",
      systemSpecs(),
    );
  if (select("append"))
    results.append = await runExperiment(
      "append-only — grow the message array",
      "m1-append",
      appendSpecs(),
    );

  const base = results.baseline;
  if (base && base.length > 0) {
    const last = base[base.length - 1]!;
    const rate = last.prompt > 0 ? (last.cached / last.prompt) * 100 : 0;
    console.log(
      `\nbaseline steady-state: cached=${last.cached} / prompt=${last.prompt} ` +
        `(${rate.toFixed(1)}%)`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
