/**
 * M9 — memory experiment harness.
 *
 * Run with:
 *   pnpm --filter @agent/server exec tsx scripts/memory-experiment.ts --salt=mimo-m9-001
 *
 * It answers MECHANISMS §5's memory hooks with real `usage` data:
 *   "发现顺序、父子目录合并、注入位置；改记忆是否炸缓存"
 * specifically the last clause: **does changing memory blow the prompt cache,
 * and where should memory be injected?**
 *
 * Two end-to-end experiments, both against the real model:
 *
 *   1. CROSS-SESSION PERSISTENCE. Session A (a fresh `Agent`) saves three facts
 *      through the real `memory` tool. Session B is then a *different* fresh
 *      `Agent` with a new session id and an empty history that opens the same
 *      on-disk store and recalls a fact it could not otherwise know.
 *
 *   2. CACHE / INJECTION POINT. The exact same rendered memory block (the real
 *      `memory` tool's `search` output) is placed two ways over >=3 identical
 *      calls each:
 *        (a) prefix rewrite — spliced into the system prompt so later bytes shift;
 *        (b) tail injection  — returned as a `role: "tool"` result at the tail.
 *      We print per call `prompt_tokens` and
 *      `usage.prompt_tokens_details.cached_tokens`. Expected: (b) keeps the
 *      cached prefix and only the new tail is uncached; (a) collapses it and
 *      pays one full re-warm.
 *
 * Bounded to <= ~30 provider calls; on HTTP 429 it backs off and retries.
 */

import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Agent,
  OpenRouterClient,
  ToolRegistry,
  builtinTools,
  withCacheBreakpoint,
  type ChatMessage,
  type ToolSchema,
  type Usage,
} from "@agent/core";
import { loadConfig } from "../src/config.js";
import {
  MEMORY_TOOL_NAME,
  MemoryStore,
  createMemoryTool,
  recall,
  renderMemories,
  type MemoryEntry,
} from "../../core/src/mechanisms/memory/index.js";

const config = loadConfig();
const client = new OpenRouterClient({
  apiKey: config.apiKey,
  referer: config.referer,
  title: config.title,
});

const MODEL = config.model; // xiaomi/mimo-v2.6-flash
const TEMPERATURE = 0;
/** Keep the model terse: one word, never a tool call, for the cache scenarios. */
const MAX_TOKENS = 16;
const CALL_DELAY_MS = 500;
const MAX_ATTEMPTS = 3;

const SALT =
  process.argv.find((a) => a.startsWith("--salt="))?.slice("--salt=".length) ||
  Date.now().toString(36);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ============================================================ part 0: setup */

const runDir = await mkdtemp(path.join(tmpdir(), "m9-memory-"));
console.log(`memory-experiment — model=${MODEL} salt=${SALT}`);
console.log(`scratch dir: ${runDir}`);

/* ================================================= part 0b: deterministic self-test */

/**
 * Zero-API check of the store/recall/render surface the cache + cross-session
 * runs do not isolate: insertion order, ranking, `recall`, `forget`, and
 * append-only replay across a fresh `open()`.
 */
async function selfTest(): Promise<void> {
  console.log("\n=== 0. deterministic self-test (no API) ===");
  const dir = path.join(runDir, "selftest");
  const store = await MemoryStore.open(dir);
  const e1 = await store.save("The build uses pnpm.", ["build"]);
  const e2 = await store.save("Prompt cache hates prefix rewrites.", ["cache"]);
  const e3 = await store.save("Memory is context injected at the right time.", ["memory"]);

  const checks: [string, boolean][] = [
    [
      "insertion order preserved",
      store.all().map((e) => e.id).join(",") === [e1.id, e2.id, e3.id].join(","),
    ],
    [
      "keyword search ranks the cache entry first",
      store.search("prompt cache prefix")[0]?.id === e2.id,
    ],
    [
      "recall top-1 matches the memory entry",
      recall("memory context time", { store, limit: 2 })[0]?.id === e3.id,
    ],
    ["search with no keywords returns newest first", store.search("")[0]?.id === e3.id],
  ];

  await store.forget(e2.id);
  checks.push([
    "forget removes the entry",
    store.size() === 2 && store.get(e2.id) === undefined,
  ]);

  // Re-open replays the append-only log (3 saves + 1 tombstone).
  const reopened = await MemoryStore.open(dir);
  checks.push([
    "reopen replays the append-only log",
    reopened.size() === 2 && reopened.get(e1.id)?.text === "The build uses pnpm.",
  ]);

  const rendered = renderMemories(reopened.all());
  checks.push([
    "render is byte-stable",
    renderMemories(reopened.all()) === rendered && rendered.includes("<memories>"),
  ]);

  for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  const failures = checks.filter(([, ok]) => !ok).length;
  console.log(`self-test: ${checks.length - failures}/${checks.length} passed`);
}

/* ================================================== part 1: cross-session */

const FACTS: { text: string; tags: string[] }[] = [
  { text: "The M9 project codename is Blue Lantern.", tags: ["m9", "codename"] },
  {
    text: "M9 memory persists as newline-delimited JSON in memories.ndjson.",
    tags: ["m9", "persistence"],
  },
  {
    text: "M9 cache rule: inject memories as a tail tool result, never rewrite the system prefix.",
    tags: ["m9", "cache"],
  },
];

const SESSION_A_PROMPT = [
  "You have a persistent memory tool. Save these three facts, one `memory` tool",
  "call per fact (action=save), using the given tags:",
  ...FACTS.map((f, i) => `${i + 1}. ${f.text} [tags: ${f.tags.join(", ")}]`),
  "",
  "After all three are saved, reply with the single word DONE.",
].join("\n");

const SESSION_B_PROMPT = [
  "You have no conversation history and a persistent memory from earlier sessions.",
  "Call the `memory` tool with action=search and query",
  '"project codename M9 Blue Lantern" to recall a fact.',
  "Then reply with the codename only.",
].join("\n");

interface ToolResultRecord {
  name: string;
  output: string;
  isError: boolean;
}

interface AgentRun {
  sessionId: string;
  usages: Usage[];
  toolCalls: number;
  toolResults: ToolResultRecord[];
  finalText: string;
  error?: string;
}

/** Real Agent run with a registry built from concrete ToolDefs. */
async function runAgentWithTools(
  sessionId: string,
  toolDefs: Parameters<ToolRegistry["register"]>[0][],
  prompt: string,
  maxSteps = 6,
): Promise<AgentRun> {
  const registry = new ToolRegistry();
  for (const tool of toolDefs) registry.register(tool);
  const agent = new Agent(
    {
      client,
      model: MODEL,
      tools: registry,
      cwd: config.repoRoot,
      permissionMode: "yolo",
      maxSteps,
      temperature: TEMPERATURE,
    },
    sessionId,
  );

  const out: AgentRun = {
    sessionId,
    usages: [],
    toolCalls: 0,
    toolResults: [],
    finalText: "",
  };

  for await (const event of agent.run(prompt)) {
    switch (event.type) {
      case "usage":
        out.usages.push(event.usage);
        break;
      case "tool.call":
        out.toolCalls += 1;
        break;
      case "tool.result":
        out.toolResults.push({
          name: event.name,
          output: event.output,
          isError: event.isError,
        });
        break;
      case "assistant.message": {
        const content = event.message.content;
        if (typeof content === "string" && content.trim().length > 0) {
          out.finalText = content;
        }
        break;
      }
      case "turn.end":
        if (event.reason === "error") out.error = event.error;
        break;
      default:
        break;
    }
  }
  return out;
}

function usageSummary(usages: Usage[]): { prompt: number; cached: number; cost: number } {
  let prompt = 0;
  let cached = 0;
  let cost = 0;
  for (const u of usages) {
    prompt += u.prompt_tokens ?? 0;
    cached += u.prompt_tokens_details?.cached_tokens ?? 0;
    cost += u.cost ?? 0;
  }
  return { prompt, cached, cost };
}

async function crossSession(): Promise<void> {
  console.log("\n=== 1. cross-session persistence (real Agents) ===");

  // Two separate store handles over the same directory: B re-reads from disk.
  const storeA = await MemoryStore.open(path.join(runDir, "session"));
  const agentA = await runAgentWithTools(
    `m9-sessionA-${SALT}`,
    [createMemoryTool(storeA)],
    SESSION_A_PROMPT,
  );
  const saved = storeA.all();
  console.log(`session A: sessionId=${agentA.sessionId} calls=${agentA.usages.length} ` +
    `tool_calls=${agentA.toolCalls} saved=${saved.length}`);
  if (agentA.error) console.log(`  A turn error: ${agentA.error}`);

  const log = await readFile(storeA.file(), "utf8");
  console.log(`log file (${storeA.file()}), ${log.trim().split(/\r?\n/).length} record(s):`);
  for (const line of log.trim().split(/\r?\n/)) console.log(`  ${line}`);

  console.log("entries after session A:");
  console.log(renderMemories(saved));

  const storeB = await MemoryStore.open(path.join(runDir, "session"));
  console.log(`session B opens a FRESH store handle (entries on disk: ${storeB.size()})`);
  const agentB = await runAgentWithTools(
    `m9-sessionB-${SALT}`,
    [createMemoryTool(storeB)],
    SESSION_B_PROMPT,
  );
  console.log(`session B: sessionId=${agentB.sessionId} calls=${agentB.usages.length} ` +
    `tool_calls=${agentB.toolCalls}`);
  if (agentB.error) console.log(`  B turn error: ${agentB.error}`);

  for (const result of agentB.toolResults) {
    if (result.name === MEMORY_TOOL_NAME) {
      console.log(`B ${MEMORY_TOOL_NAME} result:\n${result.output}`);
    }
  }
  console.log(`B final answer: ${JSON.stringify(agentB.finalText.slice(0, 200))}`);

  const recalledText = [
    ...agentB.toolResults.map((r) => r.output),
    agentB.finalText,
  ].join("\n");
  const recalled = /blue lantern/i.test(recalledText);
  console.log(`\ncross-session recall of "Blue Lantern": ${recalled ? "PASS" : "FAIL"}`);

  const a = usageSummary(agentA.usages);
  const b = usageSummary(agentB.usages);
  console.log(
    `calls: A=${agentA.usages.length} (prompt=${a.prompt}, cached=${a.cached}, ` +
      `$${a.cost.toFixed(6)})  B=${agentB.usages.length} (prompt=${b.prompt}, ` +
      `cached=${b.cached}, $${b.cost.toFixed(6)})`,
  );
}

/* ================================================= part 2: cache / injection */

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

const USER_READY = "Do not call any tools. Reply with exactly one word: ready";

interface Row {
  call: number;
  label: string;
  prompt: number;
  cached: number;
  cacheWrite: number;
  cost: number;
  finish: string;
}

interface Step {
  label: string;
  messages: ChatMessage[];
}

async function callOnce(
  messages: ChatMessage[],
  sessionId: string,
  tools: ToolSchema[],
): Promise<{ usage?: Usage; finish?: string; error?: string }> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const result = await client.chatStream({
        model: MODEL,
        messages,
        tools,
        temperature: TEMPERATURE,
        maxTokens: MAX_TOKENS,
        sessionId,
      });
      return { usage: result.usage, finish: result.finishReason };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = /429|rate|temporar|timeout|ECONN|5\d\d/i.test(message);
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      return { error: message };
    }
  }
  return { error: "exhausted retries" };
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
  const pad = (v: string, w: number, right = false) =>
    right ? v.padStart(w) : v.padEnd(w);
  const line = (cells: string[]) =>
    cells.map((cell, c) => pad(cell, widths[c]!, c !== 1)).join("  ");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) console.log(line(row));
}

async function runScenario(
  title: string,
  sessionId: string,
  steps: Step[],
  tools: ToolSchema[],
): Promise<Row[]> {
  console.log(`\n--- ${title} ---`);
  const rows: Row[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const outcome = await callOnce(step.messages, sessionId, tools);
    const u = outcome.usage;
    rows.push({
      call: i + 1,
      label: step.label,
      prompt: u?.prompt_tokens ?? 0,
      cached: u?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWrite: u?.prompt_tokens_details?.cache_write_tokens ?? 0,
      cost: u?.cost ?? 0,
      finish: outcome.error ? `error: ${outcome.error}` : (outcome.finish ?? "?"),
    });
    if (i < steps.length - 1) await sleep(CALL_DELAY_MS);
  }
  printTable(rows);
  return rows;
}

async function cacheExperiment(): Promise<void> {
  console.log("\n=== 2. cache / injection point ===");

  // A dedicated store so the rendered block is fixed and known.
  const store = await MemoryStore.open(path.join(runDir, "cache"));
  for (const fact of FACTS) await store.save(fact.text, fact.tags);

  // The real production retrieval string: exactly what the `memory` tool returns.
  const memoryTool = createMemoryTool(store);
  const retrieval = await memoryTool.execute(
    { action: "search", query: "project codename M9 memory cache injection tail system prefix", limit: 10 },
    { cwd: config.repoRoot },
  );
  const block = retrieval.output;
  const entries: MemoryEntry[] = store.all();
  console.log(
    `memory block: ${entries.length} entries, ${block.length} chars ` +
      `(= renderMemories(store.search(...)) from the real tool)`,
  );
  console.log(block);

  // Tool schema prefix is held constant across every call (M1: changing tools
  // invalidates the cache), and the memory tool is part of it.
  const registry = new ToolRegistry();
  for (const tool of builtinTools()) registry.register(tool);
  registry.register(memoryTool);
  const TOOLS: ToolSchema[] = registry.schemas();
  console.log(`tools (${TOOLS.length}): ${TOOLS.map((t) => t.function.name).join(", ")}`);

  const baseSystem = [
    `You are a minimal coding agent running memory-experiment "${SALT}".`,
    stableCorpus(90),
    USER_READY,
  ].join("\n");

  // (a) true prefix rewrite: splice the block near the TOP so every later byte
  // shifts. (Appending the block at the very end of the system would be
  // append-only and safe — M2 §c′ — which is exactly the point.)
  const rewrittenSystem = [
    `You are a minimal coding agent running memory-experiment "${SALT}".`,
    "<retrieved_memory>",
    block,
    "</retrieved_memory>",
    stableCorpus(90),
    USER_READY,
  ].join("\n");

  const systemMessage = (text: string): ChatMessage => ({
    role: "system",
    content: withCacheBreakpoint(text),
  });

  const prefixBase: ChatMessage[] = [
    systemMessage(baseSystem),
    { role: "user", content: USER_READY },
  ];
  const rewritten: ChatMessage[] = [
    systemMessage(rewrittenSystem),
    { role: "user", content: USER_READY },
  ];

  // (b) tail injection: the block as a real tool result following a synthetic
  // assistant tool_call — the same position the agent loop would append it.
  const toolCallMessage: ChatMessage = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_memory_1",
        type: "function",
        function: {
          name: MEMORY_TOOL_NAME,
          arguments: JSON.stringify({ action: "search", query: "M9 memory cache injection" }),
        },
      },
    ],
  };
  const toolResultMessage: ChatMessage = {
    role: "tool",
    tool_call_id: "call_memory_1",
    content: block,
  };
  const tail: ChatMessage[] = [...prefixBase, toolCallMessage, toolResultMessage];

  const systemBytes = baseSystem.length;
  const rewrittenBytes = rewrittenSystem.length;
  console.log(
    `system chars: base=${systemBytes}  rewritten=${rewrittenBytes}  ` +
      `block=${block.length}`,
  );

  // Three identical memory-bearing calls per style, after a two-call warm-up.
  const stepsFor = (injected: ChatMessage[]): Step[] => [
    { label: "warm#1", messages: prefixBase },
    { label: "warm#2", messages: prefixBase },
    { label: "inject#1", messages: injected },
    { label: "inject#2", messages: injected },
    { label: "inject#3", messages: injected },
  ];

  const rowsPrefix = await runScenario(
    "a — prefix rewrite (memory spliced into the system prompt)",
    `m9-memory-prefix-${SALT}`,
    stepsFor(rewritten),
    TOOLS,
  );
  await sleep(CALL_DELAY_MS);
  const rowsTail = await runScenario(
    "b — tail injection (memory returned as a tool result)",
    `m9-memory-tail-${SALT}`,
    stepsFor(tail),
    TOOLS,
  );

  const warm = (rows: Row[]) => rows.find((r) => r.label === "warm#2")?.cached ?? 0;
  const injectRows = (rows: Row[]) => rows.filter((r) => r.label.startsWith("inject"));

  console.log("\n=== summary ===");
  console.log(
    `(a) prefix rewrite: warm#2.cached=${warm(rowsPrefix)}  ` +
      `inject.cached=[${injectRows(rowsPrefix).map((r) => r.cached).join(", ")}]  ` +
      `inject.prompt=[${injectRows(rowsPrefix).map((r) => r.prompt).join(", ")}]`,
  );
  console.log(
    `(b) tail injection: warm#2.cached=${warm(rowsTail)}  ` +
      `inject.cached=[${injectRows(rowsTail).map((r) => r.cached).join(", ")}]  ` +
      `inject.prompt=[${injectRows(rowsTail).map((r) => r.prompt).join(", ")}]`,
  );

  console.log("\n=== markdown ledger ===");
  console.log(
    [
      "| style | call | label | prompt | cached | hit% | cache_write | cost($) |",
      "|---|---|---|---|---|---|---|---|",
      ...rowsPrefix.map((r) =>
        `| (a) prefix | ${r.call} | ${r.label} | ${r.prompt} | ${r.cached} | ` +
        `${r.prompt > 0 ? ((r.cached / r.prompt) * 100).toFixed(1) : "0.0"} | ${r.cacheWrite} | ${r.cost.toFixed(6)} |`,
      ),
      ...rowsTail.map((r) =>
        `| (b) tail | ${r.call} | ${r.label} | ${r.prompt} | ${r.cached} | ` +
        `${r.prompt > 0 ? ((r.cached / r.prompt) * 100).toFixed(1) : "0.0"} | ${r.cacheWrite} | ${r.cost.toFixed(6)} |`,
      ),
    ].join("\n"),
  );
}

/* ==================================================================== main */

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const select = (name: string) => requested.length === 0 || requested.includes(name);

  if (select("selftest")) await selfTest();
  if (select("cross-session")) await crossSession();
  if (select("cache")) await cacheExperiment();

  console.log(`\nscratch dir kept for inspection: ${runDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
