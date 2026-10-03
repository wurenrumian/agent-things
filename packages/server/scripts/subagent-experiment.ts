/**
 * M5 — subagent & context-isolation experiment harness.
 *
 * Run with:
 *   pnpm --filter @agent/server exec tsx scripts/subagent-experiment.ts
 *
 * It answers MECHANISMS §6 Q5: "subagent 回灌 vs 主上下文直做的 token 账".
 *
 * One investigation task is run two ways, for real, against the model:
 *
 *   inline     — the main agent reads the files itself. Every `tool` result
 *                (raw file contents) is appended to the parent's message array,
 *                so the parent context grows by everything it reads.
 *
 *   delegated  — the main agent calls the `task` tool once. A fresh subagent
 *                (own message array, own system prompt, builtin tools minus
 *                `task`) performs the same reads; only its final text is put
 *                back into the parent's context.
 *
 * For each run we print: the parent's *final* `prompt_tokens` (the size of the
 * main context on its last request), and the total tokens / cost across every
 * provider call (parent + child). The difference is the token ledger.
 *
 * Only the request bodies differ; both go straight to OpenRouter through
 * `OpenRouterClient` (no HTTP server in the loop). Bounded to a handful of
 * calls; on HTTP 429 the scenario is retried with exponential backoff.
 */

import {
  Agent,
  OpenRouterClient,
  ToolRegistry,
  builtinTools,
  type AgentEvent,
  type ToolDef,
  type Usage,
} from "@agent/core";
import {
  createTaskTool,
  summarizeUsage,
  type SubagentRun,
} from "../../core/src/mechanisms/subagent/index.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();

/** Brief constraint: this milestone measures `xiaomi/mimo-v2.6-flash`. */
const MODEL = "xiaomi/mimo-v2.6-flash";
const TEMPERATURE = 0;
/** Hard cap per agent turn so a chatty model cannot blow the call budget. */
const MAX_STEPS = 8;
const REQUEST_DELAY_MS = 500;

const client = new OpenRouterClient({
  apiKey: config.apiKey,
  referer: config.referer,
  title: config.title,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CWD = config.repoRoot;

/** Files whose raw contents are expensive to keep in the parent context. */
const FILES = [
  "packages/core/src/agent/loop.ts",
  "packages/core/src/provider/openrouter.ts",
  "packages/core/src/context/system-prompt.ts",
  "packages/core/src/tools/builtin.ts",
];

const FILE_LIST = FILES.map((f, i) => `${i + 1}. ${f}`).join("\n");

const SUMMARY_ASK = [
  "Then reply with a single compact summary (at most 120 words) explaining how",
  "the agent loop, the provider client, the system-prompt builder, and the",
  "builtin tools fit together. Your final message must be the summary text only.",
].join(" ");

const INLINE_PROMPT = [
  "Investigate the agent runtime for me.",
  "",
  "Read EACH of these files in the working directory using the read_file tool",
  "(read each whole file, do not skip any):",
  FILE_LIST,
  "",
  SUMMARY_ASK,
].join("\n");

const TASK_BRIEF = [
  "Read EACH of these files in the working directory using the read_file tool",
  "(read each whole file, do not skip any):",
  FILE_LIST,
  "",
  SUMMARY_ASK,
].join("\n");

const DELEGATED_PROMPT = [
  "Use the `task` tool exactly once to delegate the investigation below, then",
  "reply with the subagent's returned text verbatim as your final answer.",
  "",
  "Pass this exactly as the tool's `prompt` argument:",
  "```",
  TASK_BRIEF,
  "```",
].join("\n");

/* ------------------------------------------------------------------ types */

interface ParentRun {
  label: string;
  usages: Usage[];
  /** prompt_tokens of the parent's LAST request = main-context size. */
  finalPromptTokens: number;
  finalText: string;
  toolCalls: number;
  steps: number;
  turnError?: string;
}

interface ScenarioResult {
  kind: "inline" | "delegated";
  label: string;
  parent: ParentRun;
  childRuns: SubagentRun[];
  /** Any error string that looks like a rate limit. */
  retry429: boolean;
}

/* --------------------------------------------------------------- helpers */

function is429(text: string | undefined): boolean {
  if (!text) return false;
  return /\b429\b|rate.?limit/i.test(text);
}

function buildRegistry(tools: ToolDef[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

async function executeParentOnce(
  kind: "inline" | "delegated",
  label: string,
): Promise<ScenarioResult> {
  const childRuns: SubagentRun[] = [];

  const parentTools: ToolDef[] =
    kind === "inline"
      ? builtinTools()
      : [
          createTaskTool({
            client,
            model: MODEL,
            permissionMode: "yolo",
            maxSteps: MAX_STEPS,
            temperature: TEMPERATURE,
            onRun: ({ run }) => childRuns.push(run),
          }),
        ];

  const parent = new Agent(
    {
      client,
      model: MODEL,
      tools: buildRegistry(parentTools),
      cwd: CWD,
      permissionMode: "yolo",
      maxSteps: MAX_STEPS,
      temperature: TEMPERATURE,
    },
    `m5-${kind}-${Date.now().toString(36)}`,
  );

  const prompt = kind === "inline" ? INLINE_PROMPT : DELEGATED_PROMPT;
  const usages: Usage[] = [];
  let finalText = "";
  let toolCalls = 0;
  let steps = 0;
  let turnError: string | undefined;

  const collect = (event: AgentEvent): void => {
    switch (event.type) {
      case "usage":
        usages.push(event.usage);
        break;
      case "assistant.message": {
        steps += 1;
        if (
          event.message.role === "assistant" &&
          typeof event.message.content === "string" &&
          event.message.content.trim().length > 0
        ) {
          finalText = event.message.content;
        }
        break;
      }
      case "tool.call":
        toolCalls += 1;
        break;
      case "turn.end":
        if (event.reason === "error") turnError = event.error;
        break;
      default:
        break;
    }
  };

  for await (const event of parent.run(prompt)) collect(event);

  const retry429 =
    is429(turnError) || childRuns.some((r) => is429(r.error));

  return {
    kind,
    label,
    parent: {
      label,
      usages,
      finalPromptTokens: usages.at(-1)?.prompt_tokens ?? 0,
      finalText,
      toolCalls,
      steps,
      turnError,
    },
    childRuns,
    retry429,
  };
}

async function executeParent(
  kind: "inline" | "delegated",
): Promise<ScenarioResult> {
  const label = kind === "inline" ? "a-inline" : "b-delegated";
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await executeParentOnce(kind, label);
    if (!result.retry429) return result;
    const wait = 2000 * (attempt + 1);
    console.warn(`  [429] ${label}: backing off ${wait}ms (attempt ${attempt + 1})`);
    await sleep(wait);
  }
  throw new Error(`${label}: still rate-limited after 3 attempts`);
}

/* ------------------------------------------------------------------ report */

function pad(value: string, width: number, right = false): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

function usageTable(title: string, usages: Usage[]): string[] {
  const headers = ["call", "prompt", "completion", "cached", "cost($)"];
  const body = usages.map((u, i) => {
    const prompt = u.prompt_tokens ?? 0;
    const completion = u.completion_tokens ?? 0;
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    return [
      String(i + 1),
      String(prompt),
      String(completion),
      String(cached),
      (u.cost ?? 0).toFixed(6),
    ];
  });
  const widths = headers.map((h, c) =>
    Math.max(h.length, ...body.map((row) => row[c]!.length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, c) => pad(cell, widths[c]!, c !== 1)).join("  ");
  const out = [`${title}`, line(headers), widths.map((w) => "-".repeat(w)).join("  ")];
  if (body.length === 0) out.push("(no calls)");
  for (const row of body) out.push(line(row));
  return out;
}

function report(result: ScenarioResult): void {
  const parentSum = summarizeUsage(result.parent.usages);
  const childUsages = result.childRuns.flatMap((r) => r.usages);
  const childSum = summarizeUsage(childUsages);
  const totalTokens = parentSum.totalTokens + childSum.totalTokens;
  const totalCost = parentSum.cost + childSum.cost;

  console.log(`\n=== ${result.label} ===`);
  console.log(
    `parent final prompt_tokens=${result.parent.finalPromptTokens}  ` +
      `parent steps=${result.parent.steps}  parent tool_calls=${result.parent.toolCalls}  ` +
      `child runs=${result.childRuns.length}`,
  );
  if (result.parent.turnError) console.log(`  parent turn error: ${result.parent.turnError}`);
  for (const r of result.childRuns) {
    if (r.error) console.log(`  child error: ${r.error}`);
  }
  console.log(usageTable("parent calls", result.parent.usages).join("\n"));
  if (childUsages.length > 0) {
    console.log(usageTable("child calls", childUsages).join("\n"));
  }
  console.log(
    `TOTALS  parent: prompt=${parentSum.promptTokens} completion=${parentSum.completionTokens} ` +
      `total=${parentSum.totalTokens} cost=$${parentSum.cost.toFixed(6)} call(s)=${parentSum.calls}`,
  );
  if (childUsages.length > 0) {
    console.log(
      `        child : prompt=${childSum.promptTokens} completion=${childSum.completionTokens} ` +
        `total=${childSum.totalTokens} cost=$${childSum.cost.toFixed(6)} call(s)=${childSum.calls}`,
    );
  }
  console.log(
    `        ALL   : total_tokens=${totalTokens} cost=$${totalCost.toFixed(6)} ` +
      `calls=${parentSum.calls + childSum.calls}`,
  );
  console.log(`\nparent final answer (first 200 chars): ${result.parent.finalText.slice(0, 200)}`);
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  console.log(`subagent-experiment — model=${MODEL}`);
  console.log(`cwd=${CWD}`);
  console.log(`files under investigation:\n${FILE_LIST}`);

  const requested = process.argv
    .slice(2)
    .filter((a) => !a.startsWith("--"));
  const select = (k: string) => requested.length === 0 || requested.includes(k);

  const results: ScenarioResult[] = [];

  if (select("inline")) {
    results.push(await executeParent("inline"));
    await sleep(REQUEST_DELAY_MS);
  }
  if (select("delegated")) {
    results.push(await executeParent("delegated"));
  }

  for (const result of results) report(result);

  const inline = results.find((r) => r.kind === "inline");
  const delegated = results.find((r) => r.kind === "delegated");
  if (inline && delegated) {
    const inlineSum = summarizeUsage(inline.parent.usages);
    const delegatedParent = summarizeUsage(delegated.parent.usages);
    const delegatedChild = summarizeUsage(delegated.childRuns.flatMap((r) => r.usages));
    const delegatedTotal = delegatedParent.totalTokens + delegatedChild.totalTokens;

    console.log("\n=== LEDGER (markdown) ===");
    console.log(
      [
        "| run | parent final prompt_tokens | parent total | child total | all-calls total | all-calls cost($) |",
        "|---|---|---|---|---|---|",
        `| a-inline | ${inline.parent.finalPromptTokens} | ${inlineSum.totalTokens} | — | ${inlineSum.totalTokens} | ${inlineSum.cost.toFixed(6)} |`,
        `| b-delegated | ${delegated.parent.finalPromptTokens} | ${delegatedParent.totalTokens} | ${delegatedChild.totalTokens} | ${delegatedTotal} | ${(delegatedParent.cost + delegatedChild.cost).toFixed(6)} |`,
      ].join("\n"),
    );
    const parentSaving = inline.parent.finalPromptTokens - delegated.parent.finalPromptTokens;
    const totalDelta = inlineSum.totalTokens - delegatedTotal;
    console.log(
      `\nparent-context saved by delegation: ${parentSaving} prompt_tokens ` +
        `(${inline.parent.finalPromptTokens} -> ${delegated.parent.finalPromptTokens})`,
    );
    console.log(
      `all-calls token delta (inline - delegated): ${totalDelta} ` +
        `(${totalDelta >= 0 ? "delegation cheaper overall" : "delegation costs more in total"})`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
