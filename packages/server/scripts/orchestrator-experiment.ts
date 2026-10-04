/**
 * M10 — orchestrator experiment harness.
 *
 * Run with:
 *   pnpm --filter @agent/server exec tsx scripts/orchestrator-experiment.ts
 *   pnpm --filter @agent/server exec tsx scripts/orchestrator-experiment.ts inline orchestrated
 *
 * It answers the M10 brief with real data from `xiaomi/mimo-v2.6-flash`:
 *
 *   (a) inline       — one coordinator Agent does three micro-tasks itself; every
 *                      raw tool result lands in its message array.
 *   (b) orchestrated — the coordinator uses `createOrchestratorTools` to spawn
 *                      three isolated workers in parallel and consumes only their
 *                      one-line `worker_done` summaries. The token ledger
 *                      compares (a) vs (b).
 *   (c) question     — a real worker calls `ask_coordinator`, flips to `blocked`,
 *                      the coordinator `wait`s for the question, `reply`s and
 *                      `ack`s, and the worker resumes.
 *   (d) replay       — a pure-Mailbox proof that an unacked delivery is replayed,
 *                      plus a durability (reload) check. No model calls.
 *
 * Bounded to ~20 provider calls; on HTTP 429 the affected leg backs off and
 * retries. No HTTP server; `OpenRouterClient` is called directly.
 */

import {
  Agent,
  OpenRouterClient,
  ToolRegistry,
  builtinTools,
  type AgentEvent,
  type ChatMessage,
  type ToolDef,
  type Usage,
} from "@agent/core";
import os from "node:os";
import path from "node:path";
import { unlinkSync } from "node:fs";
import {
  Mailbox,
  Supervisor,
  createOrchestratorTools,
  summarizeUsage,
  type WorkerReport,
  type WorkerUsageSummary,
} from "../../core/src/mechanisms/orchestrator/index.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();

const MODEL = "xiaomi/mimo-v2.6-flash";
const TEMPERATURE = 0;
const MAX_STEPS = 8;
const REQUEST_DELAY_MS = 400;
const CWD = config.repoRoot;

const client = new OpenRouterClient({
  apiKey: config.apiKey,
  referer: config.referer,
  title: config.title,
});

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- micro-tasks */

/**
 * Independent micro-tasks whose *raw* tool output is large (whole source
 * files) but whose *answers* are one token. That asymmetry is the point: the
 * inline coordinator pays for the raw output, the orchestrated coordinator only
 * pays for the answer.
 */
const TASKS = [
  {
    name: "loop-maxsteps",
    task:
      'Read "packages/core/src/agent/loop.ts" and answer with just the integer ' +
      "used as the fallback for maxSteps when the config does not set it. Reply " +
      "with a single integer and nothing else.",
  },
  {
    name: "or-title-header",
    task:
      'Read "packages/core/src/provider/openrouter.ts" and answer with just the ' +
      "name of the HTTP header it sets from `config.title`. Reply with a single " +
      "token and nothing else.",
  },
  {
    name: "sp-first-section",
    task:
      'Read "packages/core/src/context/system-prompt.ts" and answer with just ' +
      "the `name` of the first section pushed in `buildSystemPrompt`. Reply " +
      "with a single word and nothing else.",
  },
] as const;

const TASK_LINES = TASKS.map((t, i) => `${i + 1}. [${t.name}] ${t.task}`).join("\n");

const INLINE_PROMPT = [
  "Do all three of the following micro-tasks yourself, using your tools:",
  "",
  TASK_LINES,
  "",
  "Then reply with EXACTLY three lines, one per task, each formatted as",
  "`name: answer`. Add nothing else.",
].join("\n");

const ORCHESTRATED_PROMPT = [
  "You are the coordinator. You MUST delegate; you have no file tools.",
  "",
  "Step 1: call spawn_worker exactly three times (all three may be issued in the",
  "same step) with these exact workers:",
  TASK_LINES,
  "",
  "Step 2: call wait_for with {\"types\":[\"worker_done\"],\"timeout_ms\":120000}",
  "repeatedly until you have received three `worker_done` messages (one per",
  "worker). Each message body is that worker's final answer.",
  "",
  "Step 3: reply with EXACTLY three lines, one per worker in the order above,",
  "each formatted as `name: answer`. Add nothing else.",
].join("\n");

/* ------------------------------------------------------------------- helpers */

function is429(text: string | undefined): boolean {
  if (!text) return false;
  return /\b429\b|rate.?limit/i.test(text);
}

function buildRegistry(tools: ToolDef[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

interface RunStats {
  usages: Usage[];
  finalText: string;
  finalPromptTokens: number;
  steps: number;
  toolCalls: number;
  error?: string;
}

async function collect(agent: Agent, prompt: string): Promise<RunStats> {
  const usages: Usage[] = [];
  let finalText = "";
  let steps = 0;
  let toolCalls = 0;
  let error: string | undefined;

  for await (const event of agent.run(prompt)) {
    const e = event as AgentEvent;
    switch (e.type) {
      case "usage":
        usages.push(e.usage);
        break;
      case "assistant.message":
        steps += 1;
        if (
          e.message.role === "assistant" &&
          typeof e.message.content === "string" &&
          e.message.content.trim().length > 0
        ) {
          finalText = e.message.content;
        }
        break;
      case "tool.call":
        toolCalls += 1;
        break;
      case "turn.end":
        if (e.reason === "error") error = e.error;
        break;
      default:
        break;
    }
  }

  return {
    usages,
    finalText: finalText.trim(),
    finalPromptTokens: usages.at(-1)?.prompt_tokens ?? 0,
    steps,
    toolCalls,
    error,
  };
}

function textOf(message: ChatMessage): string {
  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
}

function pad(value: string, width: number, right = false): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

function usageTable(title: string, usages: Usage[]): string[] {
  const headers = ["call", "prompt", "completion", "cached", "cost($)"];
  const body = usages.map((u, i) => {
    const prompt = u.prompt_tokens ?? 0;
    const completion = u.completion_tokens ?? 0;
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    return [String(i + 1), String(prompt), String(completion), String(cached), (u.cost ?? 0).toFixed(6)];
  });
  const widths = headers.map((h, c) => Math.max(h.length, ...body.map((row) => row[c]!.length)));
  const line = (cells: string[]): string =>
    cells.map((cell, c) => pad(cell, widths[c]!, c !== 1)).join("  ");
  const out = [title, line(headers), widths.map((w) => "-".repeat(w)).join("  ")];
  if (body.length === 0) out.push("(no calls)");
  for (const row of body) out.push(line(row));
  return out;
}

function truncated(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/* ------------------------------------------------------------------- leg (a) */

interface InlineResult {
  stats: RunStats;
  sessionId: string;
  messageCount: number;
}

async function runInlineOnce(): Promise<InlineResult> {
  const sessionId = `m10-inline-${Date.now().toString(36)}`;
  const agent = new Agent(
    {
      client,
      model: MODEL,
      tools: buildRegistry(builtinTools()),
      cwd: CWD,
      permissionMode: "yolo",
      maxSteps: MAX_STEPS,
      temperature: TEMPERATURE,
    },
    sessionId,
  );
  const stats = await collect(agent, INLINE_PROMPT);
  return { stats, sessionId, messageCount: agent.messages.length };
}

async function runInline(): Promise<InlineResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await runInlineOnce();
    if (!is429(result.stats.error)) return result;
    const wait = 3000 * (attempt + 1);
    console.warn(`  [429] inline: backing off ${wait}ms`);
    await sleep(wait);
  }
  throw new Error("inline: still rate-limited after 3 attempts");
}

/* ------------------------------------------------------------------- leg (b) */

interface OrchestratedResult {
  coordinator: RunStats;
  coordinatorSessionId: string;
  coordinatorMessageCount: number;
  workers: WorkerReport[];
  records: ReturnType<Supervisor["registry"]["snapshot"]>;
  routed: number;
  supervisor: Supervisor;
}

async function runOrchestratedOnce(): Promise<OrchestratedResult> {
  let routed = 0;
  const supervisor = new Supervisor({
    client,
    model: MODEL,
    cwd: CWD,
    permissionMode: "yolo",
    maxSteps: MAX_STEPS,
    temperature: TEMPERATURE,
    questionTimeoutMs: 60_000,
    onMessage: () => {
      routed += 1;
    },
  });

  const coordinatorSessionId = `m10-orch-coord-${Date.now().toString(36)}`;
  const coordinator = new Agent(
    {
      client,
      model: MODEL,
      tools: buildRegistry(createOrchestratorTools(supervisor)),
      cwd: CWD,
      permissionMode: "yolo",
      maxSteps: MAX_STEPS,
      temperature: TEMPERATURE,
    },
    coordinatorSessionId,
  );

  const stats = await collect(coordinator, ORCHESTRATED_PROMPT);

  // Whatever the coordinator managed to wait for, collect every worker.
  await supervisor.waitForAll(120_000);

  return {
    coordinator: stats,
    coordinatorSessionId,
    coordinatorMessageCount: coordinator.messages.length,
    workers: supervisor.reports(),
    records: supervisor.registry.snapshot(),
    routed,
    supervisor,
  };
}

async function runOrchestrated(): Promise<OrchestratedResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await runOrchestratedOnce();
    const rateLimited =
      is429(result.coordinator.error) ||
      result.workers.some((w) => is429(w.error));
    if (!rateLimited) return result;
    result.supervisor.dispose();
    const wait = 3000 * (attempt + 1);
    console.warn(`  [429] orchestrated: backing off ${wait}ms`);
    await sleep(wait);
  }
  throw new Error("orchestrated: still rate-limited after 3 attempts");
}

/* ------------------------------------------------------------------- leg (c) */

interface QuestionResult {
  workerId: string;
  questionBody: string;
  questionId: string;
  replyBody: string;
  workerText: string;
  workerStatus: string;
  transitions: Array<{ from?: string; to: string; reason?: string }>;
  usages: Usage[];
}

async function runQuestionLeg(): Promise<QuestionResult> {
  const supervisor = new Supervisor({
    client,
    model: MODEL,
    cwd: CWD,
    permissionMode: "yolo",
    maxSteps: MAX_STEPS,
    temperature: TEMPERATURE,
    questionTimeoutMs: 60_000,
  });

  const task = [
    "You must ask the coordinator for a decision before answering.",
    'Your FIRST action must be to call the `ask_coordinator` tool with',
    'question "Which word should I use as my final answer: ALPHA or BETA?" and',
    'subject "answer format".',
    "When the coordinator replies, reply with EXACTLY the single word it told",
    "you to use and nothing else.",
  ].join(" ");

  const record = supervisor.spawn({ name: "asker", task });
  const workerId = record.id;

  // Coordinator side: block on the structured mailbox (never poll a terminal).
  const question = await supervisor.waitFor(["question"], 60_000, {
    to: supervisor.coordinatorId,
  });
  if (!question) {
    await supervisor.stopAll();
    throw new Error("question leg: worker never asked a question");
  }
  const blockedRecord = supervisor.registry.get(workerId);
  const blockedStatus = blockedRecord?.status ?? "unknown";

  const reply = supervisor.reply(
    workerId,
    "Use the single word BETA.",
    "answer format",
  );
  // Ack the question so it is not replayed to the next coordinator wait.
  supervisor.mailbox.ack(question.id);

  await supervisor.waitForAll(120_000);

  const report = supervisor.report(workerId);
  const finalRecord = supervisor.registry.get(workerId);
  const result: QuestionResult = {
    workerId,
    questionBody: question.body,
    questionId: question.id,
    replyBody: reply.body,
    workerText: report?.text ?? "",
    workerStatus: finalRecord?.status ?? "unknown",
    transitions: (finalRecord?.transitions ?? []).map((t) => ({
      from: t.from,
      to: t.to,
      reason: t.reason,
    })),
    usages: report?.usages ?? [],
  };

  console.log(`  question received while worker status=${blockedStatus}`);
  supervisor.dispose();
  return result;
}

/* ------------------------------------------------------------------- leg (d) */

interface ReplayResult {
  sentIds: string[];
  firstDelivery: string;
  replayDelivery: string;
  afterAckDelivery: string;
  waitedId: string;
  waitedReplayId: string;
  pendingCount: number;
  durableReloadOk: boolean;
  durableFile: string;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

async function runReplayLeg(): Promise<ReplayResult> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = ""): void => {
    checks.push({ name, ok, detail });
  };

  const mailbox = new Mailbox();
  const q1 = mailbox.send({ from: "w1", to: "coordinator", type: "question", body: "first?" });
  const q2 = mailbox.send({ from: "w2", to: "coordinator", type: "question", body: "second?" });

  const first = mailbox.deliverNext(["question"]);
  const replay = mailbox.deliverNext(["question"]);
  check(
    "unacked delivery is replayed",
    first?.id === q1.id && replay?.id === q1.id,
    `first=${first?.id} replay=${replay?.id} q1=${q1.id}`,
  );
  check(
    "oldest-first FIFO with a filter",
    first?.id === q1.id && first.from === "w1",
    `${first?.id} from ${first?.from}`,
  );

  mailbox.ack(q1.id);
  const afterAck = mailbox.deliverNext(["question"]);
  check(
    "ack advances the queue to the next message",
    afterAck?.id === q2.id,
    `afterAck=${afterAck?.id} q2=${q2.id}`,
  );
  check(
    "pending() reflects only the unacked tail",
    mailbox.pending(["question"]).length === 1,
    `${mailbox.pending(["question"]).length} pending`,
  );

  // wait() obeys the same replay rule as deliverNext().
  const note = mailbox.send({ from: "w1", to: "coordinator", type: "note", body: "keep me" });
  const waited = await mailbox.wait(["note"], 1000);
  const waitedReplay = await mailbox.wait(["note"], 1000);
  check(
    "wait() replays an unacked message too",
    waited?.id === note.id && waitedReplay?.id === note.id,
    `waited=${waited?.id} replay=${waitedReplay?.id}`,
  );
  mailbox.ack(note.id);
  const afterNoteAck = await mailbox.wait(["note"], 0);
  check("acked message stops replaying", afterNoteAck === null, `${afterNoteAck}`);

  // Durability: reload the ops log from disk and compare state.
  const durableFile = path.join(os.tmpdir(), `m10-mailbox-${Date.now().toString(36)}.jsonl`);
  const durable = new Mailbox({ file: durableFile });
  const d1 = durable.send({ from: "w9", to: "coordinator", type: "escalation", body: "disk-backed" });
  durable.send({ from: "w9", to: "coordinator", type: "note", body: "unacked-note" });
  durable.ack(d1.id);
  const reloaded = new Mailbox({ file: durableFile });
  const reloadedEsc = reloaded.get(d1.id);
  const durableReloadOk =
    reloadedEsc?.acked === true &&
    reloaded.pending().length === 1 &&
    reloaded.pending()[0]?.body === "unacked-note";
  check(
    "mailbox survives a reload (durable ops log)",
    durableReloadOk,
    `${reloaded.size()} message(s), ${reloaded.pending().length} pending`,
  );

  return {
    sentIds: [q1.id, q2.id],
    firstDelivery: first?.id ?? "—",
    replayDelivery: replay?.id ?? "—",
    afterAckDelivery: afterAck?.id ?? "—",
    waitedId: waited?.id ?? "—",
    waitedReplayId: waitedReplay?.id ?? "—",
    pendingCount: mailbox.pending().length,
    durableReloadOk,
    durableFile,
    checks,
  };
}

/* ------------------------------------------------------------------- report */

function ledgerRow(
  label: string,
  finalPromptTokens: number,
  coordinator: WorkerUsageSummary,
  worker: WorkerUsageSummary,
): string {
  const allTokens = coordinator.totalTokens + worker.totalTokens;
  const allCost = coordinator.cost + worker.cost;
  const calls = coordinator.calls + worker.calls;
  const workerCell = worker.calls > 0 ? String(worker.totalTokens) : "—";
  return `| ${label} | ${finalPromptTokens} | ${coordinator.totalTokens} | ${workerCell} | ${allTokens} | ${allCost.toFixed(6)} | ${calls} |`;
}

function printLedger(
  inline: InlineResult,
  orchestrated: OrchestratedResult,
): void {
  const inlineSum = summarizeUsage(inline.stats.usages);
  const coordSum = summarizeUsage(orchestrated.coordinator.usages);
  const workerSum = summarizeUsage(orchestrated.workers.flatMap((w) => w.usages));

  console.log("\n=== LEDGER (markdown) ===");
  console.log(
    [
      "| run | coordinator final prompt_tokens | coordinator total | worker total | all-calls total | all-calls cost($) | calls |",
      "|---|---|---|---|---|---|---|",
      ledgerRow("a-inline", inline.stats.finalPromptTokens, inlineSum, {
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        cost: 0,
      }),
      ledgerRow("b-orchestrated", orchestrated.coordinator.finalPromptTokens, coordSum, workerSum),
    ].join("\n"),
  );

  const saved = inline.stats.finalPromptTokens - orchestrated.coordinator.finalPromptTokens;
  const pct =
    inline.stats.finalPromptTokens > 0
      ? ((saved / inline.stats.finalPromptTokens) * 100).toFixed(1)
      : "—";
  const totalDelta = inlineSum.totalTokens - (coordSum.totalTokens + workerSum.totalTokens);
  const costDelta = inlineSum.cost - (coordSum.cost + workerSum.cost);
  console.log(
    `\ncoordinator main-context saved by orchestration: ${saved} prompt_tokens ` +
      `(${inline.stats.finalPromptTokens} -> ${orchestrated.coordinator.finalPromptTokens}, ${pct}%)`,
  );
  console.log(
    `all-calls token delta (inline - orchestrated): ${totalDelta}; ` +
      `cost delta: $${costDelta.toFixed(6)}`,
  );
}

function printIsolation(
  inline: InlineResult,
  orchestrated: OrchestratedResult,
): void {
  console.log("\n=== ISOLATION ===");
  const sessions = [
    inline.sessionId,
    orchestrated.coordinatorSessionId,
    ...orchestrated.workers.map((w) => w.sessionId),
  ];
  console.log(`session ids (${sessions.length}): ${sessions.join(", ")}`);
  console.log(
    `distinct session ids: ${new Set(sessions).size === sessions.length}`,
  );
  console.log(
    `inline coordinator context: ${inline.messageCount} messages; ` +
      `orchestrated coordinator context: ${orchestrated.coordinatorMessageCount} messages`,
  );
  for (const w of orchestrated.workers) {
    console.log(
      `worker ${w.id} ("${w.sessionId}"): status? text="${truncated(w.text, 80)}" ` +
        `steps=${w.steps} tool_calls=${w.toolCalls} own_messages=${w.messageCount}`,
    );
  }
  console.log(`routed coordinator messages: ${orchestrated.routed}`);
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  console.log(`orchestrator-experiment — model=${MODEL}`);
  console.log(`cwd=${CWD}`);

  const requested = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const select = (k: string): boolean => requested.length === 0 || requested.includes(k);

  let inline: InlineResult | undefined;
  let orchestrated: OrchestratedResult | undefined;

  if (select("inline")) {
    console.log("\n================ (a) inline ================");
    inline = await runInline();
    console.log(`inline coordinator final prompt_tokens=${inline.stats.finalPromptTokens}`);
    console.log(`inline final answer:\n${inline.stats.finalText}`);
    await sleep(REQUEST_DELAY_MS);
  }

  if (select("orchestrated")) {
    console.log("\n================ (b) orchestrated ================");
    orchestrated = await runOrchestrated();
    console.log(`coordinator final prompt_tokens=${orchestrated.coordinator.finalPromptTokens}`);
    console.log(
      `coordinator steps=${orchestrated.coordinator.steps} tool_calls=${orchestrated.coordinator.toolCalls} ` +
        `routed_messages=${orchestrated.routed}`,
    );
    console.log(`coordinator final answer:\n${orchestrated.coordinator.finalText}`);
    await sleep(REQUEST_DELAY_MS);
  }

  if (inline && orchestrated) {
    printLedger(inline, orchestrated);
    printIsolation(inline, orchestrated);
  }

  if (select("question")) {
    console.log("\n================ (c) question / reply / ack ================");
    const q = await runQuestionLeg();
    console.log(`worker: ${q.workerId}`);
    console.log(`Q id=${q.questionId}: "${q.questionBody}"`);
    console.log(`A: "${q.replyBody}"`);
    console.log(`worker final answer: "${q.workerText}"`);
    console.log(`worker final status: ${q.workerStatus}`);
    console.log("status transitions:");
    for (const t of q.transitions) {
      console.log(`  ${t.from ?? "(new)"} -> ${t.to}${t.reason ? ` (${t.reason})` : ""}`);
    }
  }

  if (select("replay")) {
    console.log("\n================ (d) mailbox replay / durability ================");
    const r = await runReplayLeg();
    console.log(
      `sent=[${r.sentIds.join(", ")}] first=${r.firstDelivery} ` +
        `replay=${r.replayDelivery} afterAck=${r.afterAckDelivery}`,
    );
    console.log(
      `wait=${r.waitedId} waitReplay=${r.waitedReplayId} pending=${r.pendingCount}`,
    );
    for (const c of r.checks) {
      console.log(`  [${c.ok ? "PASS" : "FAIL"}] ${c.name} — ${c.detail}`);
    }
    try {
      unlinkSync(r.durableFile);
    } catch {
      /* best-effort cleanup */
    }
  }

  console.log("\ndone.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
