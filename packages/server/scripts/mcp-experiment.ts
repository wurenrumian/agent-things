/**
 * M4 — MCP context-management experiment.
 *
 * Run with:
 *   pnpm --filter @agent/server exec tsx scripts/mcp-experiment.ts
 *
 * Three parts:
 *   1. round-trip — a real JSON-RPC 2.0 stdio round-trip against the fixture
 *      MCP server (`packages/core/src/mechanisms/mcp/fixtures/echo-server.mjs`):
 *      `initialize` -> `tools/list` -> `tools/call`. No SDK, no mocks.
 *   2. token cost — fetch N tools (N = 0,1,5,20) from the fixture, map them to
 *      our `ToolSchema`, inject them, and read the real `usage.prompt_tokens`.
 *   3. cache impact — with `OpenRouterClient` directly, add one MCP tool to a
 *      warm tool set and reorder the set, reading `cached_tokens` each call
 *      (ties to docs/runs/m1-cache.md §1.3).
 *
 * Calls OpenRouter directly (no HTTP server), so the only thing that varies is
 * the request body we deliberately change. Budget: <= 20 API calls, 429 backoff.
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
import {
  McpStdioClient,
  mcpResultText,
  mcpToolsToSchemas,
} from "../../core/src/mechanisms/mcp/index.js";
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
/** Let the provider's prefix cache settle between calls. */
const CALL_DELAY_MS = 500;
/** Hard ceiling for the whole run (brief: <= ~20). */
const MAX_API_CALLS = 20;

let apiCalls = 0;

/** Per-run salt so repeated runs start from cold prefixes. */
const SALT =
  process.argv.find((a) => a.startsWith("--salt="))?.slice("--salt=".length) ||
  Date.now().toString(36);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- fixtures */

/** Long deterministic corpus to push the prefix past the cacheable minimum. */
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
    `You are a minimal coding agent running MCP experiment "${tag}@${SALT}".`,
    "Sentinel: SENTINEL-AAAA.",
    "Operation policy follows.",
    "",
    stableCorpus(90),
  ].join("\n");
}

function systemMessage(text: string): ChatMessage {
  return { role: "system", content: withCacheBreakpoint(text) };
}

/** The real builtin tool set, in `ToolRegistry.list()` order. */
function baseToolSchemas(): ToolSchema[] {
  const registry = new ToolRegistry();
  for (const tool of builtinTools()) registry.register(tool);
  return registry.schemas();
}

const BASE_TOOLS = baseToolSchemas();

const USER_OK = "Reply with exactly one word: ok";

/** Fetch N tools from a fresh fixture server and map them deterministically. */
async function fetchMcpSchemas(n: number): Promise<ToolSchema[]> {
  const mcp = new McpStdioClient({ env: { MCP_FIXTURE_TOOLS: String(n) } });
  try {
    await mcp.connect();
    return mcpToolsToSchemas(await mcp.listTools());
  } finally {
    mcp.close();
  }
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
      maxTokens: MAX_TOKENS,
      sessionId,
    });
    return { usage: result.usage, finish: result.finishReason };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (attempt < 3) {
      // Back off harder on rate limits (HTTP 429).
      const is429 = message.includes("429");
      await sleep((is429 ? 3000 : 1500) * (attempt + 1));
      return callOnce(spec, sessionId, attempt + 1);
    }
    return { error: message };
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

/* --------------------------------------------------------- part 1: round-trip */

async function proveRoundTrip(): Promise<void> {
  console.log("\n=== part 1 — real MCP JSON-RPC round-trip (stdio, no SDK) ===");
  const mcp = new McpStdioClient({ env: { MCP_FIXTURE_TOOLS: "2" } });
  try {
    const init = await mcp.connect();
    console.log(
      `initialize -> protocolVersion=${init.protocolVersion} ` +
        `server=${init.serverInfo.name}@${init.serverInfo.version}`,
    );

    const tools = await mcp.listTools();
    console.log(`tools/list -> ${tools.length} tools:`);
    for (const t of tools) {
      console.log(`  - ${t.name}: ${t.description ?? ""}`);
    }

    // Deterministic mapping: feed a reversed list and show the output order is
    // stable regardless of server enumeration order.
    const mapped = mcpToolsToSchemas([...tools].reverse());
    console.log(
      `mcpToolsToSchemas(reversed input) -> ${mapped
        .map((s) => s.function.name)
        .join(", ")}`,
    );

    const call = await mcp.callTool("echo_1", {
      text: "hello MCP",
      uppercase: true,
      repeat: 2,
    });
    console.log(
      `tools/call echo_1 {text:"hello MCP",uppercase:true,repeat:2} ` +
        `-> isError=${call.isError === true} content=${JSON.stringify(mcpResultText(call))}`,
    );
  } finally {
    mcp.close();
  }
}

/* -------------------------------------------------------- part 2: token cost */

async function measureTokenCost(): Promise<Map<number, number>> {
  console.log(
    "\n=== part 2 — prompt_tokens cost of injecting N eagerly-listed MCP tools ===",
  );
  const system = makeSystem("mcp-cost");
  const ns = [0, 1, 5, 20];
  const promptByN = new Map<number, number>();
  const rows: Row[] = [];

  for (let i = 0; i < ns.length; i++) {
    const n = ns[i]!;
    const schemas = n > 0 ? await fetchMcpSchemas(n) : [];
    const spec: CallSpec = {
      label: `N=${n}`,
      messages: [systemMessage(system), { role: "user", content: USER_OK }],
      tools: schemas,
    };
    const r = await callOnce(spec, "m4-cost");
    const u = r.usage;
    promptByN.set(n, u?.prompt_tokens ?? 0);
    rows.push({
      call: i + 1,
      label: `${spec.label} (${schemas.length} schemas)`,
      prompt: u?.prompt_tokens ?? 0,
      completion: u?.completion_tokens ?? 0,
      cached: u?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWrite: u?.prompt_tokens_details?.cache_write_tokens ?? 0,
      cost: u?.cost ?? 0,
      finish: r.error ? `error: ${r.error}` : (r.finish ?? "?"),
    });
    if (i < ns.length - 1) await sleep(CALL_DELAY_MS);
  }
  printTable(rows);
  return promptByN;
}

/* -------------------------------------------------------- part 3: cache drop */

async function measureCacheAdd(): Promise<Row[]> {
  const system = makeSystem("mcp-cache-add");
  const mcpSchemas = await fetchMcpSchemas(1);
  const withMcp = [...BASE_TOOLS, ...mcpSchemas];
  const mk = (label: string, tools: ToolSchema[]): CallSpec => ({
    label,
    messages: [systemMessage(system), { role: "user", content: USER_OK }],
    tools,
  });
  console.log(
    "\n=== part 3a — cache drop when +1 MCP tool joins the set (m1 §1.3) ===",
  );
  return runExperiment("cache-add — append one MCP tool to a warm set", "m4-cache-add", [
    mk("base#1", BASE_TOOLS),
    mk("base#2", BASE_TOOLS),
    mk("base+mcp#1", withMcp),
    mk("base+mcp#2", withMcp),
    mk("base#3", BASE_TOOLS),
  ]);
}

async function measureCacheOrder(): Promise<Row[]> {
  const system = makeSystem("mcp-cache-order");
  const mcpSchemas = await fetchMcpSchemas(1);
  const normal = [...BASE_TOOLS, ...mcpSchemas];
  // Same members, MCP tool moved to the front: pure order change.
  const reordered = [...mcpSchemas, ...BASE_TOOLS];
  const mk = (label: string, tools: ToolSchema[]): CallSpec => ({
    label,
    messages: [systemMessage(system), { role: "user", content: USER_OK }],
    tools,
  });
  console.log(
    "\n=== part 3b — cache drop when the same tools are reordered (m1 §1.2) ===",
  );
  return runExperiment("cache-order — reorder the tools array", "m4-cache-order", [
    mk("normal#1", normal),
    mk("normal#2", normal),
    mk("reordered#1", reordered),
    mk("reordered#2", reordered),
  ]);
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<void> {
  console.log(`mcp-experiment — model=${MODEL}`);
  console.log(
    "cached = usage.prompt_tokens_details.cached_tokens (real, per call)",
  );

  await proveRoundTrip();

  // `--roundtrip-only` validates the stdio client without spending API calls.
  if (process.argv.includes("--roundtrip-only")) {
    console.log("\n(--roundtrip-only: skipping OpenRouter measurements)");
    return;
  }

  // `--only=cost,add` runs a subset; default is everything.
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const selected = onlyArg
    ? new Set(onlyArg.slice("--only=".length).split(",").map((s) => s.trim()))
    : undefined;
  const wants = (part: string) => selected === undefined || selected.has(part);

  const promptByN = wants("cost") ? await measureTokenCost() : new Map<number, number>();
  const addRows = wants("add") ? await measureCacheAdd() : [];
  const orderRows = wants("order") ? await measureCacheOrder() : [];

  console.log("\n=== summary (part 2: token cost) ===");
  if (promptByN.size === 0) {
    console.log("(skipped: cost part not selected)");
  } else {
    const base = promptByN.get(0) ?? 0;
    const warmTools = BASE_TOOLS.length;
    for (const n of [1, 5, 20]) {
      const prompt = promptByN.get(n) ?? 0;
      const delta = prompt - base;
      const perTool = n > 0 ? delta / n : 0;
      console.log(
        `N=${String(n).padStart(2)}  prompt=${prompt}  delta_vs_N0=${delta}  ` +
          `~${perTool.toFixed(1)} tok/tool`,
      );
    }
    console.log(
      `(N=0 baseline prompt=${base}; ${warmTools} builtin tools baseline)`,
    );
  }

  console.log("\n=== summary (part 3: cache) ===");
  const rec = (rows: Row[], label: string) => rows.find((r) => r.label === label);
  const addWarm = rec(addRows, "base#2");
  const addFirst = rec(addRows, "base+mcp#1");
  const orderWarm = rec(orderRows, "normal#2");
  const orderFirst = rec(orderRows, "reordered#1");
  if (addWarm && addFirst) {
    console.log(
      `add 1 MCP tool: warm cached=${addWarm.cached}/${addWarm.prompt} -> ` +
        `${addFirst.cached}/${addFirst.prompt} ` +
        `(dropped ${addWarm.cached - addFirst.cached} cached tokens; ` +
        `prompt +${addFirst.prompt - addWarm.prompt})`,
    );
  }
  if (orderWarm && orderFirst) {
    console.log(
      `reorder same tools: warm cached=${orderWarm.cached}/${orderWarm.prompt} -> ` +
        `${orderFirst.cached}/${orderFirst.prompt} ` +
        `(dropped ${orderWarm.cached - orderFirst.cached} cached tokens)`,
    );
  }
  console.log(`\ntotal OpenRouter API calls: ${apiCalls} (ceiling ${MAX_API_CALLS})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
