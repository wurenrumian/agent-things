/**
 * M12 — interactive approval + slash commands experiment harness.
 *
 * Run with:
 *   pnpm --filter @agent/server exec tsx scripts/approval-experiment.ts --salt=m12-001
 *
 * Three parts, all local except the two real turns:
 *
 *   0. DETERMINISTIC SELF-TEST (no API). Exercises the `commands/` registry:
 *      `parseCommand` (including the `/etc/hosts` path trap), the four builtins
 *      driven by a stub host, the synthetic-reply vs tail-inject result shapes,
 *      and unknown-command fallthrough.
 *
 *   1. DENY. A real `Agent` turn whose gate (the bundled ordered policy) returns
 *      `ask` for `write_file`. The `approvals` callback resolves `deny`, so the
 *      tool must NOT run and the file must stay absent. We record the exact
 *      event sequence and assert the loop paused on the async callback.
 *
 *   2. ALLOW. Same turn, approving instead. The tool executes and the file's
 *      exact bytes appear. Same event-sequence + pause assertions, plus bytes.
 *
 * The sequence the loop must produce for the gated call:
 *   tool.call → permission.decision → approval.requested → approval.resolved
 *   → tool.result            (allow)
 * and without `tool.result` on the deny path (the model gets a Denied tool
 * message instead). Bounded to a handful of provider calls; backs off on 429.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Agent,
  OpenRouterClient,
  ToolRegistry,
  builtinTools,
  type AgentConfig,
  type AgentEvent,
} from "@agent/core";
import { loadConfig } from "../src/config.js";
import {
  HookRunner,
  Policy,
  decide,
} from "../../core/src/mechanisms/hooks/index.js";
import {
  CommandRegistry,
  parseCommand,
  registerBuiltins,
} from "../../core/src/mechanisms/commands/index.js";

const config = loadConfig();
const client = new OpenRouterClient({
  apiKey: config.apiKey,
  referer: config.referer,
  title: config.title,
});
const MODEL = config.model;
const TEMPERATURE = 0;
/** How long the (stub) human "thinks" before deciding — proves the pause. */
const APPROVAL_DELAY_MS = 250;
const MAX_ATTEMPTS = 3;
const SALT =
  process.argv.find((a) => a.startsWith("--salt="))?.slice("--salt=".length) ||
  Date.now().toString(36);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (err: unknown): boolean =>
  /429|rate.?limit|too many requests/i.test(
    err instanceof Error ? err.message : String(err),
  );

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`,
  );
  if (!ok) failures += 1;
}

/* ============================================ part 0: commands self-test */

async function commandsSelfTest(): Promise<void> {
  console.log("\n=== 0. slash-command registry (no API) ===");

  // parseCommand / path trap
  check("/help parses", JSON.stringify(parseCommand("/help")) === '{"name":"help","args":""}');
  check(
    "/memory query parses",
    JSON.stringify(parseCommand("/memory cache rule")) ===
      '{"name":"memory","args":"cache rule"}',
  );
  check("/etc/hosts is NOT a command", parseCommand("/etc/hosts") === null);
  check("plain text is not a command", parseCommand("hello") === null);

  // builtins over a stub host (no real mechanisms)
  const registry = new CommandRegistry();
  const calls: string[] = [];
  registerBuiltins(registry, {
    recallMemory(query) {
      calls.push(`recall:${query}`);
      return `<memories>\n- stub hit for ${query}\n</memories>`;
    },
    workerSnapshot() {
      calls.push("workers");
      return "Workers (2):\n  [done] w1\n  [running] w2";
    },
    async compactNow() {
      calls.push("compact");
      return "Compacted 1000 → 200 tokens.";
    },
  });

  const help = await registry.get("help")!.handler("", { sessionId: "s", cwd: "." });
  check(
    "/help lists all four builtins",
    ["/help", "/memory", "/workers", "/compact"].every((u) =>
      (help.reply ?? "").includes(u),
    ),
  );

  const mem = await registry.get("memory")!.handler("blue lantern", {
    sessionId: "s",
    cwd: ".",
  });
  check("/memory calls the host recall", calls.includes("recall:blue lantern"));
  check("/memory reply contains the hit", (mem.reply ?? "").includes("blue lantern"));
  const memUsage = await registry.get("memory")!.handler("", { sessionId: "s", cwd: "." });
  check("/memory with no query returns usage", (memUsage.reply ?? "").startsWith("Usage:"));

  const workers = await registry.get("workers")!.handler("", { sessionId: "s", cwd: "." });
  check("/workers returns the snapshot", (workers.reply ?? "").includes("Workers (2)"));
  const compact = await registry.get("compact")!.handler("", { sessionId: "s", cwd: "." });
  check("/compact returns the report", (compact.reply ?? "").includes("Compacted"));

  // Unknown command: parses, but the registry has no entry ⇒ falls through.
  const unknown = parseCommand("/foo bar");
  check(
    "unknown /foo parses but is unregistered (falls through to the model)",
    unknown?.name === "foo" && registry.get(unknown.name) === undefined,
  );

  // The other result branch: tail injection (never a system rewrite).
  registry.register({
    name: "inject-demo",
    description: "test-only",
    usage: "/inject-demo",
    handler: () => ({
      inject: [{ role: "user", content: "<recalled>tail context</recalled>" }],
    }),
  });
  const injected = await registry.get("inject-demo")!.handler("", {
    sessionId: "s",
    cwd: ".",
  });
  const firstInject = injected.inject?.[0];
  check(
    "inject result appends a tail message (no system rewrite)",
    injected.inject?.length === 1 &&
      firstInject?.role === "user" &&
      firstInject?.content === "<recalled>tail context</recalled>",
  );
}

/* =================================================== parts 1/2: real turns */

interface LegResult {
  events: AgentEvent[];
  approvals: { toolCallId: string; decision: "allow" | "deny" }[];
  toolCallId?: string;
  fileBytes?: Buffer;
  fileExists: boolean;
  deniedToolMessage: boolean;
  error?: string;
}

/** Build the real M6 gate: the bundled ordered policy (`write_file` ⇒ ask). */
async function buildGate(): Promise<AgentConfig["gate"]> {
  const policy = await Policy.fromFixture();
  const hooks = new HookRunner();
  return async (request) => {
    const decision = await decide(policy, hooks, request);
    return {
      decision: decision.kind,
      reason: decision.reason,
      input: decision.input,
      records: decision.trace,
      mutated: decision.mutated,
    };
  };
}

async function runLeg(
  label: string,
  decision: "allow" | "deny",
  fileName: string,
  content: string,
  cwd: string,
): Promise<LegResult> {
  const gate = await buildGate();
  const registry = new ToolRegistry();
  for (const tool of builtinTools()) registry.register(tool);

  const events: AgentEvent[] = [];
  const approvals: LegResult["approvals"] = [];
  const prompt =
    `Call the write_file tool exactly once with ` +
    `path="${fileName}" and content="${content}". ` +
    `Do not call any other tool. After the tool call, reply with the single word DONE.`;

  const agent = new Agent(
    {
      client,
      model: MODEL,
      tools: registry,
      cwd,
      permissionMode: "yolo",
      maxSteps: 4,
      temperature: TEMPERATURE,
      gate,
      approvals: async (request) => {
        approvals.push({ toolCallId: request.toolCallId, decision });
        await sleep(APPROVAL_DELAY_MS); // the loop is paused right here
        return decision;
      },
    },
    `m12-${label}-${SALT}`,
  );

  for await (const event of agent.run(prompt)) events.push(event);

  const call = events.find(
    (e): e is Extract<AgentEvent, { type: "tool.call" }> =>
      e.type === "tool.call" && e.name === "write_file",
  );
  const abs = path.join(cwd, fileName);
  let fileExists = false;
  let fileBytes: Buffer | undefined;
  try {
    fileBytes = await readFile(abs);
    fileExists = true;
  } catch {
    fileExists = false;
  }
  const deniedToolMessage = agent.messages.some(
    (m) =>
      m.role === "tool" &&
      typeof m.content === "string" &&
      m.content.startsWith("Denied:"),
  );
  const turnEnd = events.find(
    (e): e is Extract<AgentEvent, { type: "turn.end" }> => e.type === "turn.end",
  );

  return {
    events,
    approvals,
    toolCallId: call?.toolCallId,
    fileBytes,
    fileExists,
    deniedToolMessage,
    error: turnEnd?.reason === "error" ? turnEnd.error : undefined,
  };
}

/** Retry a leg on 429 / transient error, and when the model never calls the tool. */
async function runLegWithRetry(
  label: string,
  decision: "allow" | "deny",
  fileName: string,
  content: string,
  cwd: string,
): Promise<LegResult> {
  let last: LegResult | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      last = await runLeg(label, decision, fileName, content, cwd);
    } catch (err) {
      if (isRateLimit(err) && attempt < MAX_ATTEMPTS) {
        const wait = 2000 * attempt;
        console.log(`  [${label}] rate limited; backing off ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
    if (last.toolCallId) return last;
    if (attempt < MAX_ATTEMPTS) {
      console.log(`  [${label}] model did not call write_file; retrying`);
      await sleep(500);
    }
  }
  return last!;
}

function relevantSequence(
  events: AgentEvent[],
  toolCallId: string,
): string[] {
  return events
    .filter(
      (e) =>
        ("toolCallId" in e ? e.toolCallId === toolCallId : false) &&
        (e.type === "tool.call" ||
          e.type === "permission.decision" ||
          e.type === "approval.requested" ||
          e.type === "approval.resolved" ||
          e.type === "tool.result"),
    )
    .map((e) => e.type);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function report(label: string, events: AgentEvent[], toolCallId: string): void {
  console.log(`\n-- ${label}: event sequence for ${toolCallId} --`);
  const seq = relevantSequence(events, toolCallId);
  console.log(`  ${seq.join(" → ")}`);
  const requested = events.find(
    (e): e is Extract<AgentEvent, { type: "approval.requested" }> =>
      e.type === "approval.requested" && e.toolCallId === toolCallId,
  );
  const resolved = events.find(
    (e): e is Extract<AgentEvent, { type: "approval.resolved" }> =>
      e.type === "approval.resolved" && e.toolCallId === toolCallId,
  );
  if (requested && resolved) {
    console.log(
      `  pause: requested.at=${requested.at} resolved.at=${resolved.at} ` +
        `Δ=${resolved.at - requested.at}ms`,
    );
  }
}

async function main(): Promise<void> {
  console.log(`approval-experiment — model=${MODEL} salt=${SALT}`);
  await commandsSelfTest();

  const scratch = await mkdtemp(path.join(tmpdir(), "m12-approval-"));
  console.log(`\nscratch dir: ${scratch}`);
  try {
    /* ------------------------------------------------------------ DENY leg */
    console.log("\n=== 1. deny blocks the tool ===");
    const denyFile = "m12-deny.txt";
    const denySentinel = `M12-DENY-${SALT}`;
    const deny = await runLegWithRetry("deny", "deny", denyFile, denySentinel, scratch);
    if (deny.error) console.log(`  turn error: ${deny.error}`);
    if (!deny.toolCallId) {
      check("model called write_file (deny leg)", false, "no write_file tool.call");
      return finish();
    }
    report("deny", deny.events, deny.toolCallId);

    const denySeq = relevantSequence(deny.events, deny.toolCallId);
    check(
      "deny sequence is tool.call → permission.decision → approval.requested → approval.resolved",
      denySeq.join(",") ===
        "tool.call,permission.decision,approval.requested,approval.resolved",
      denySeq.join(","),
    );
    check("approval callback was awaited (pause ≥ delay)", pauseHeld(deny.events, deny.toolCallId));
    check("file was NOT created", !deny.fileExists, `exists=${deny.fileExists}`);
    check("no tool.result for the gated call", !denySeq.includes("tool.result"));
    check("model received a Denied tool message", deny.deniedToolMessage);

    /* ----------------------------------------------------------- ALLOW leg */
    console.log("\n=== 2. allow executes the tool ===");
    const allowFile = "m12-allow.txt";
    const allowSentinel = `M12-ALLOW-${SALT}`;
    const allow = await runLegWithRetry("allow", "allow", allowFile, allowSentinel, scratch);
    if (allow.error) console.log(`  turn error: ${allow.error}`);
    if (!allow.toolCallId) {
      check("model called write_file (allow leg)", false, "no write_file tool.call");
      return finish();
    }
    report("allow", allow.events, allow.toolCallId);

    const allowSeq = relevantSequence(allow.events, allow.toolCallId);
    check(
      "allow sequence is tool.call → permission.decision → approval.requested → approval.resolved → tool.result",
      allowSeq.join(",") ===
        "tool.call,permission.decision,approval.requested,approval.resolved,tool.result",
      allowSeq.join(","),
    );
    check("approval callback was awaited (pause ≥ delay)", pauseHeld(allow.events, allow.toolCallId));
    check("file exists after allow", allow.fileExists);
    const text = allow.fileBytes?.toString("utf8") ?? "";
    check(
      "file bytes contain the sentinel",
      text.includes(allowSentinel),
      `bytes=${allow.fileBytes?.length ?? 0} sha256=${allow.fileBytes ? sha256(allow.fileBytes).slice(0, 12) : "-"}`,
    );
    console.log(`  allow file content:\n    ${JSON.stringify(text)}`);
    if (allow.fileBytes) {
      console.log(
        `  allow file bytes=${allow.fileBytes.length} sha256=${sha256(allow.fileBytes)}`,
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  finish();
}

/** True when the resolved event lands at least APPROVAL_DELAY_MS after request. */
function pauseHeld(events: AgentEvent[], toolCallId: string): boolean {
  const requested = events.find(
    (e): e is Extract<AgentEvent, { type: "approval.requested" }> =>
      e.type === "approval.requested" && e.toolCallId === toolCallId,
  );
  const resolved = events.find(
    (e): e is Extract<AgentEvent, { type: "approval.resolved" }> =>
      e.type === "approval.resolved" && e.toolCallId === toolCallId,
  );
  if (!requested || !resolved) return false;
  return resolved.at - requested.at >= APPROVAL_DELAY_MS - 20;
}

function finish(): never {
  console.log("\n=== summary ===");
  console.log(
    failures === 0
      ? "all M12 approval + command assertions PASSED"
      : `${failures} assertion(s) FAILED`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error(
    `approval-experiment fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
  );
  process.exit(1);
});
