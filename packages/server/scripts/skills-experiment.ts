/**
 * M2 — skills & progressive disclosure experiment harness.
 *
 * Run with:
 *   pnpm --filter @agent/server exec tsx scripts/skills-experiment.ts --salt=mimo-m2-001
 *
 * Question (MECHANISMS §6 Q1, §2): getting a skill's *body* into context — which
 * of the three injection styles preserves the provider prompt cache?
 *
 *   (a) append the body as a new **user message** at the tail
 *   (b) return the body as a **tool result** (via the real `use_skill` ToolDef)
 *   (c) **rewrite the system prompt** to embed the body
 *
 * For each style we make four calls over the *same logical prefix*:
 *   warm#1, warm#2  -> establish + confirm the cache on the stable prefix
 *   inject          -> add the body by that style's mechanism
 *   follow          -> one more appended turn
 *
 * We print the provider-reported `usage.prompt_tokens_details.cached_tokens` for
 * every call. Expected: (a)/(b) keep the cached prefix and only the newly
 * appended tokens are uncached; (c) invalidates the prefix, so `cached` collapses
 * on `inject` and only recovers on the next identical call.
 *
 * The body is loaded through `createUseSkillTool(...).execute(...)` — the exact
 * code path production would run — so the numbers describe the real tool result
 * string, not a stand-in.
 *
 * Pass `--salt=<value>` to pin the run prefix (otherwise a random salt is used so
 * a fresh run starts from cold cache). On HTTP 429 the harness backs off and
 * retries; total base calls are 12.
 */

import {
  OpenRouterClient,
  ToolRegistry,
  builtinTools,
  withCacheBreakpoint,
  type AssistantMessage,
  type ChatMessage,
  type ToolSchema,
  type Usage,
} from "@agent/core";
import { loadConfig } from "../src/config.js";
import {
  SkillRegistry,
  createUseSkillTool,
} from "../../core/src/mechanisms/skills/index.js";

const config = loadConfig();
const client = new OpenRouterClient({
  apiKey: config.apiKey,
  referer: config.referer,
  title: config.title,
});

const MODEL = config.model;
const TEMPERATURE = 0;
const MAX_TOKENS = 24;
/** Let the provider's cache settle between calls. */
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

const USER_READY =
  "Do not call any tools. Reply with exactly one word: ready";
const FOLLOW_UP = "Name the skill you just used in one short phrase.";

/** Build the stable system prompt for a scenario. */
function makeSystem(tag: string): string {
  return [
    `You are a minimal coding agent running skill experiment "${tag}@${SALT}".`,
    "Available skills are listed below; use_skill loads one on demand.",
    "",
    stableCorpus(90),
    "",
    "<available_skills>",
    registry.metadataBlock(),
    "</available_skills>",
  ].join("\n");
}

/**
 * The (c) "rewrite" system prompt: the skill body is spliced in as a section
 * near the *top* of the system, exactly how a real system-prompt rewrite would
 * place it. That shifts every subsequent byte, so the previously cached prefix
 * no longer matches. (Contrast: appending the body at the very end of the system
 * would leave the prefix intact — prefix caching is purely positional.)
 */
function makeSystemRewrite(tag: string, body: string): string {
  return [
    `You are a minimal coding agent running skill experiment "${tag}@${SALT}".`,
    "<skill_body>",
    body,
    "</skill_body>",
    "Available skills are listed below; use_skill loads one on demand.",
    "",
    stableCorpus(90),
    "",
    "<available_skills>",
    registry.metadataBlock(),
    "</available_skills>",
  ].join("\n");
}

function systemMessage(text: string): ChatMessage {
  return { role: "system", content: withCacheBreakpoint(text) };
}

/* ------------------------------------------------------------------- run */

interface CallSpec {
  label: string;
  messages: ChatMessage[];
}

type Step = CallSpec | ((prev: AssistantMessage) => CallSpec);

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
  message: AssistantMessage;
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
    return { usage: result.usage, finish: result.finishReason, message: result.message };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retryable = /429|rate|temporar|timeout|ECONN|5\d\d/i.test(message);
    if (retryable && attempt < MAX_ATTEMPTS - 1) {
      await sleep(2000 * 2 ** attempt); // 2s, 4s
      return callOnce(spec, sessionId, attempt + 1);
    }
    return {
      error: message,
      message: { role: "assistant", content: "(request failed)" },
    };
  }
}

/** Keep history valid: never replay a dangling assistant tool_call. */
function asHistory(message: AssistantMessage): AssistantMessage {
  if (message.tool_calls && message.tool_calls.length > 0) {
    return { role: "assistant", content: message.content ?? "(tool call)" };
  }
  return { role: "assistant", content: message.content ?? "" };
}

function toRow(call: number, label: string, outcome: CallOutcome): Row {
  const u = outcome.usage;
  return {
    call,
    label,
    prompt: u?.prompt_tokens ?? 0,
    cached: u?.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWrite: u?.prompt_tokens_details?.cache_write_tokens ?? 0,
    cost: u?.cost ?? 0,
    finish: outcome.error ? `error: ${outcome.error}` : (outcome.finish ?? "?"),
  };
}

async function runScenario(title: string, sessionId: string, steps: Step[]): Promise<Row[]> {
  console.log(`\n=== ${title} ===`);
  const rows: Row[] = [];
  let prev: AssistantMessage = { role: "assistant", content: "" };
  for (let i = 0; i < steps.length; i++) {
    const raw = steps[i]!;
    const spec = typeof raw === "function" ? raw(prev) : raw;
    const outcome = await callOnce(spec, sessionId);
    prev = asHistory(outcome.message);
    rows.push(toRow(i + 1, spec.label, outcome));
    if (i < steps.length - 1) await sleep(CALL_DELAY_MS);
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

/* ---------------------------------------------------------------- main */

console.log(`skills-experiment — model=${MODEL} salt=${SALT}`);

const registry = await SkillRegistry.fromFixture();
const useSkill = createUseSkillTool(registry);

// The real builtin tool set plus use_skill, in ToolRegistry's stable name order.
const toolRegistry = new ToolRegistry();
for (const tool of builtinTools()) toolRegistry.register(tool);
toolRegistry.register(useSkill);
const TOOLS: ToolSchema[] = toolRegistry.schemas();

const SKILL = "code-review";
const skillMeta = registry.get(SKILL);
if (!skillMeta) throw new Error(`fixture skill "${SKILL}" not found`);

// The body enters through the *real* tool executor — same string production sees.
const loaded = await useSkill.execute({ name: SKILL }, { cwd: config.repoRoot });
if (loaded.isError) throw new Error(`use_skill failed: ${loaded.output}`);
const body = loaded.output;
const refs = await registry.references(SKILL);

console.log(
  `L1 metadata: ${registry.size()} skill(s), ${registry.metadataBlock().length} chars\n` +
    `L2 body:     ${body.length} chars (~${Math.ceil(body.length / 4)} tokens)\n` +
    `L3 refs:     ${refs.join(", ")}`,
);
console.log(`tools (${TOOLS.length}): ${TOOLS.map((t) => t.function.name).join(", ")}`);

const baseSystem = makeSystem("skills");
const rewrittenSystem = makeSystemRewrite("skills", body);

// (b) synth assistant tool_call + tool result carrying the L2 body.
const toolCallMessage: ChatMessage = {
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: "call_use_skill_1",
      type: "function",
      function: { name: "use_skill", arguments: JSON.stringify({ name: SKILL }) },
    },
  ],
};
const toolResultMessage: ChatMessage = {
  role: "tool",
  tool_call_id: "call_use_skill_1",
  content: body,
};

const prefix: ChatMessage[] = [
  systemMessage(baseSystem),
  { role: "user", content: USER_READY },
];

function tailUserSpecs(): Step[] {
  const injected: ChatMessage[] = [...prefix, { role: "user", content: body }];
  return [
    { label: "warm#1", messages: prefix },
    { label: "warm#2", messages: prefix },
    { label: "inject-user", messages: injected },
    (prev) => ({
      label: "follow-user",
      messages: [...injected, prev, { role: "user", content: FOLLOW_UP }],
    }),
  ];
}

function toolResultSpecs(): Step[] {
  const injected: ChatMessage[] = [...prefix, toolCallMessage, toolResultMessage];
  return [
    { label: "warm#1", messages: prefix },
    { label: "warm#2", messages: prefix },
    { label: "inject-tool", messages: injected },
    (prev) => ({
      label: "follow-tool",
      messages: [...injected, prev, { role: "user", content: FOLLOW_UP }],
    }),
  ];
}

function systemRewriteSpecs(): Step[] {
  const rewritten: ChatMessage[] = [
    systemMessage(rewrittenSystem),
    { role: "user", content: USER_READY },
  ];
  return [
    { label: "warm#1", messages: prefix },
    { label: "warm#2", messages: prefix },
    { label: "inject-system", messages: rewritten },
    (prev) => ({
      label: "follow-system",
      messages: [...rewritten, prev, { role: "user", content: FOLLOW_UP }],
    }),
  ];
}

const requested = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"));
const select = (name: string) =>
  requested.length === 0 || requested.includes(name);

const results: Record<string, Row[]> = {};
if (select("tail-user"))
  results["tail-user"] = await runScenario(
    "a — body appended as a tail user message",
    "m2-skills-tail-user",
    tailUserSpecs(),
  );
if (select("tool-result"))
  results["tool-result"] = await runScenario(
    "b — body returned as a tool result (use_skill)",
    "m2-skills-tool-result",
    toolResultSpecs(),
  );
if (select("system-rewrite"))
  results["system-rewrite"] = await runScenario(
    "c — body embedded by rewriting the system prompt",
    "m2-skills-system-rewrite",
    systemRewriteSpecs(),
  );

console.log("\n=== summary ===");
for (const [name, rows] of Object.entries(results)) {
  const warm = rows.find((r) => r.label === "warm#2");
  const inject = rows.find((r) => r.label.startsWith("inject"));
  const follow = rows.find((r) => r.label.startsWith("follow"));
  console.log(
    `${name.padEnd(14)} warm2.cached=${warm?.cached ?? 0}  ` +
      `inject.cached=${inject?.cached ?? 0} (prompt ${inject?.prompt ?? 0})  ` +
      `follow.cached=${follow?.cached ?? 0}`,
  );
}
