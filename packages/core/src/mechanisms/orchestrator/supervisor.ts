/**
 * M10 — the {@link Supervisor}.
 *
 * Spawn N workers **in parallel** from specs, each a fresh {@link Agent} built
 * by an injected {@link AgentFactory} (the default mirrors
 * `mechanisms/subagent`: builtin tools + a coordination tool, its own session
 * and message array). The supervisor:
 *
 *  - registers every worker in the {@link WorkerRegistry} and records its
 *    lifecycle transitions (`starting → running → blocked → running → done`);
 *  - collects each worker's final text + raw `usage` into a {@link WorkerReport};
 *  - routes mailbox messages addressed to the coordinator to an `onMessage`
 *    callback (so the caller can react without polling);
 *  - emits one `worker_done` mailbox message per finished worker;
 *  - exposes `waitForAll(timeout)` and `stopAll()`.
 *
 * A worker that needs a coordinator decision calls the `ask_coordinator` tool
 * (installed by the default factory): it sends a `question`, flips its own
 * registry status to `blocked`, and blocks on the mailbox until a `reply`
 * arrives — at which point the tool resolves and the worker resumes as
 * `running`. That is the whole "blocked until answered" behaviour, with no PTY.
 */

import { Agent } from "../../agent/loop.js";
import type { AgentEvent } from "../../events.js";
import type { PermissionMode } from "../../permissions.js";
import type { OpenRouterClient } from "../../provider/openrouter.js";
import { builtinTools } from "../../tools/builtin.js";
import { ToolRegistry, type ToolDef } from "../../tools/registry.js";
import type { ChatMessage, Usage } from "../../types.js";
import { nextId } from "./ids.js";
import { Mailbox, type MailboxFilter, type SendInput } from "./mailbox.js";
import { WorkerRegistry } from "./registry.js";
import type {
  MailboxMessage,
  MailboxMessageType,
  WorkerRecord,
  WorkerReport,
  WorkerStatus,
  WorkerUsageSummary,
} from "./types.js";

/** A worker request handed to {@link Supervisor.spawn}. */
export interface WorkerSpec {
  /** Explicit id; otherwise generated. Also used as the Agent session id. */
  id?: string;
  name: string;
  task: string;
  /** Override the worker's system prompt for this one worker. */
  systemPrompt?: string;
}

/** A {@link WorkerSpec} whose id has been resolved by the supervisor. */
export interface ResolvedWorkerSpec extends WorkerSpec {
  id: string;
}

/** Everything a worker's factory needs to build agents + coordination tools. */
export interface WorkerContext {
  workerId: string;
  coordinatorId: string;
  mailbox: Mailbox;
  registry: WorkerRegistry;
}

/**
 * The minimal worker interface the supervisor drives. `run()` yields the same
 * `AgentEvent` stream an {@link Agent} does, so the default factory simply wraps
 * one. `sessionId` / `messages` are optional observability.
 */
export interface WorkerAgent {
  sessionId?: string;
  messages?: () => ChatMessage[];
  run(signal?: AbortSignal): AsyncGenerator<AgentEvent>;
}

/** Build a worker agent for a resolved spec. Injected for tests / test doubles. */
export type AgentFactory = (
  spec: ResolvedWorkerSpec,
  ctx: WorkerContext,
) => WorkerAgent;

/** Options for {@link defaultAgentFactory}. */
export interface DefaultAgentFactoryOptions {
  client: OpenRouterClient;
  model: string;
  cwd: string;
  permissionMode?: PermissionMode;
  maxSteps?: number;
  temperature?: number;
  platform?: string;
  /** Extra tools appended to every worker's toolset. */
  extraTools?: ToolDef[];
  /** Default worker system prompt (per-spec override wins). */
  systemPrompt?: string;
  /** Default blocking timeout for a worker's `ask_coordinator` call. */
  questionTimeoutMs?: number;
}

/** Options for the {@link Supervisor}. */
export interface SupervisorOptions {
  client: OpenRouterClient;
  model: string;
  cwd: string;
  /** Id the workers address when they need a decision. Default `"coordinator"`. */
  coordinatorId?: string;
  permissionMode?: PermissionMode;
  maxSteps?: number;
  temperature?: number;
  platform?: string;
  /** Override the agent factory (tests / custom workers). */
  factory?: AgentFactory;
  /** Extra tools appended to every default-built worker. */
  workerTools?: ToolDef[];
  /** Default worker system prompt. */
  workerSystemPrompt?: string;
  /** Default blocking timeout for a worker's `ask_coordinator` call. */
  questionTimeoutMs?: number;
  /** Reuse an existing mailbox (e.g. a durable one). */
  mailbox?: Mailbox;
  /** Durable mailbox file; ignored when `mailbox` is supplied. */
  mailboxFile?: string;
  /** Called for each mailbox message addressed to the coordinator. */
  onMessage?: (message: MailboxMessage) => void;
  /** Injectable clock. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * The worker's own system prompt. A worker is not a conversational partner: it
 * runs one bounded task and returns one final message the coordinator pays for.
 */
export const WORKER_SYSTEM_PROMPT = `You are a worker agent coordinated by a supervisor.

You operate in your own isolated context: you cannot see the coordinator's
conversation or any other worker's. The coordinator receives only your final
reply; everything else (tool calls and their raw output) is discarded.

- Work autonomously and use your tools to investigate before you conclude.
- End with your answer as plain text, not a tool call.
- Be concise and information-dense: the coordinator pays for every byte.
- If you genuinely need a decision only the coordinator can make, call the
  \`ask_coordinator\` tool and wait; the coordinator will reply.`;

/** Sum a list of provider `usage` records into one row. Exported for the ledger. */
export function summarizeUsage(usages: Usage[]): WorkerUsageSummary {
  const out: WorkerUsageSummary = {
    calls: usages.length,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cost: 0,
  };
  for (const u of usages) {
    const prompt = u.prompt_tokens ?? 0;
    const completion = u.completion_tokens ?? 0;
    out.promptTokens += prompt;
    out.completionTokens += completion;
    out.totalTokens += u.total_tokens ?? prompt + completion;
    out.cachedTokens += u.prompt_tokens_details?.cached_tokens ?? 0;
    out.cost += u.cost ?? 0;
  }
  return out;
}

/**
 * The worker-side coordination tool. Sends a `question` to the coordinator and
 * blocks on a `reply`. While blocked the registry marks the worker `blocked`, so
 * the coordinator can observe *why* a worker has stalled (instead of timing out
 * a black box).
 */
function createAskCoordinatorTool(
  ctx: WorkerContext,
  defaultTimeoutMs: number,
): ToolDef {
  return {
    name: "ask_coordinator",
    description:
      "Ask the coordinator a question when you need a decision you cannot make " +
      "yourself. This blocks until the coordinator replies, then returns the " +
      "reply text.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to send to the coordinator.",
        },
        subject: {
          type: "string",
          description: "A short (3–5 word) label for the question.",
        },
        timeout_ms: {
          type: "integer",
          description: "How long to wait for a reply (default 30000).",
        },
      },
      required: ["question"],
    },
    async execute(input) {
      const question =
        typeof input["question"] === "string" ? input["question"].trim() : "";
      if (!question) {
        return { output: "Error: `question` is required.", isError: true };
      }
      const subject =
        typeof input["subject"] === "string" ? input["subject"] : undefined;
      const timeout =
        typeof input["timeout_ms"] === "number"
          ? input["timeout_ms"]
          : defaultTimeoutMs;

      ctx.mailbox.send({
        from: ctx.workerId,
        to: ctx.coordinatorId,
        type: "question",
        subject,
        body: question,
      });
      ctx.registry.update(
        ctx.workerId,
        { status: "blocked" },
        "awaiting coordinator reply",
      );

      const reply = await ctx.mailbox.wait(
        ["reply"],
        timeout,
        { to: ctx.workerId },
      );

      ctx.registry.update(
        ctx.workerId,
        { status: "running" },
        reply ? "coordinator replied" : "question timed out",
      );

      if (!reply) {
        return { output: `(no coordinator reply within ${timeout}ms)` };
      }
      // Consume the reply so it is not replayed on the next delivery.
      ctx.mailbox.ack(reply.id);
      return { output: reply.body };
    },
  };
}

/**
 * Build the default {@link AgentFactory}. Each worker gets the builtin tools
 * plus `ask_coordinator`; `task` is absent (workers do not spawn sub-workers).
 */
export function defaultAgentFactory(
  opts: DefaultAgentFactoryOptions,
): AgentFactory {
  const questionTimeoutMs = opts.questionTimeoutMs ?? 30_000;
  return (spec, ctx) => {
    const registry = new ToolRegistry();
    const tools: ToolDef[] = [
      ...builtinTools(),
      createAskCoordinatorTool(ctx, questionTimeoutMs),
      ...(opts.extraTools ?? []),
    ];
    for (const tool of tools) registry.register(tool);

    const agent = new Agent(
      {
        client: opts.client,
        model: opts.model,
        tools: registry,
        cwd: opts.cwd,
        permissionMode: opts.permissionMode ?? "yolo",
        maxSteps: opts.maxSteps ?? 12,
        temperature: opts.temperature,
        platform: opts.platform,
        systemPromptOverride: spec.systemPrompt ?? opts.systemPrompt ?? WORKER_SYSTEM_PROMPT,
      },
      spec.id,
    );

    return {
      sessionId: agent.sessionId,
      messages: () => agent.messages,
      run: (signal) => agent.run(spec.task, signal),
    };
  };
}

interface WorkerSlot {
  spec: ResolvedWorkerSpec;
  controller: AbortController;
  settled: Promise<void>;
}

export class Supervisor {
  /** The worker ledger. */
  readonly registry: WorkerRegistry;
  /** The durable FIFO coordination queue. */
  readonly mailbox: Mailbox;
  /** The id workers address when they need a decision. */
  readonly coordinatorId: string;

  private readonly factory: AgentFactory;
  private readonly reportMap = new Map<string, WorkerReport>();
  private readonly slots = new Map<string, WorkerSlot>();
  private readonly onMessage?: (message: MailboxMessage) => void;
  private readonly now: () => number;
  private unsubscribeMailbox?: () => void;

  constructor(opts: SupervisorOptions) {
    this.now = opts.now ?? Date.now;
    this.coordinatorId = opts.coordinatorId ?? "coordinator";
    this.onMessage = opts.onMessage;
    this.registry = new WorkerRegistry(this.now);

    this.mailbox =
      opts.mailbox ??
      new Mailbox({ now: this.now, file: opts.mailboxFile });

    this.unsubscribeMailbox = this.mailbox.subscribe((message) => {
      if (message.to !== this.coordinatorId) return;
      this.onMessage?.(message);
    });

    this.factory =
      opts.factory ??
      defaultAgentFactory({
        client: opts.client,
        model: opts.model,
        cwd: opts.cwd,
        permissionMode: opts.permissionMode,
        maxSteps: opts.maxSteps,
        temperature: opts.temperature,
        platform: opts.platform,
        extraTools: opts.workerTools,
        systemPrompt: opts.workerSystemPrompt,
        questionTimeoutMs: opts.questionTimeoutMs,
      });
  }

  /**
   * Start one worker and return its registry record immediately. The agent runs
   * in the background; collect it with `waitForAll` or by waiting for its
   * `worker_done` mailbox message.
   */
  spawn(spec: WorkerSpec): WorkerRecord {
    const id = spec.id ?? nextId("worker");
    const resolved: ResolvedWorkerSpec = { ...spec, id };
    const record = this.registry.add({
      id,
      name: spec.name,
      task: spec.task,
      status: "starting",
      sessionId: id,
      startedAt: this.now(),
    });

    const controller = new AbortController();
    const ctx: WorkerContext = {
      workerId: id,
      coordinatorId: this.coordinatorId,
      mailbox: this.mailbox,
      registry: this.registry,
    };

    let worker: WorkerAgent;
    try {
      worker = this.factory(resolved, ctx);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.registry.update(
        id,
        { status: "failed", error, endedAt: this.now() },
        "factory threw",
      );
      return this.registry.get(id) ?? record;
    }

    if (worker.sessionId) {
      this.registry.update(
        id,
        { status: "running", sessionId: worker.sessionId },
        "spawned",
      );
    } else {
      this.registry.update(id, { status: "running" }, "spawned");
    }

    const settled = this.runWorker(resolved, worker, controller);
    this.slots.set(id, { spec: resolved, controller, settled });
    return this.registry.get(id) ?? record;
  }

  /** Start several workers; returns their initial records. */
  spawnAll(specs: WorkerSpec[]): WorkerRecord[] {
    return specs.map((spec) => this.spawn(spec));
  }

  /**
   * Resolve once every worker spawned so far has settled, or when `timeoutMs`
   * elapses. Always resolves with a registry snapshot (never rejects).
   */
  async waitForAll(timeoutMs?: number): Promise<WorkerRecord[]> {
    const pending = [...this.slots.values()].map((slot) => slot.settled);
    const all = Promise.allSettled(pending);
    if (timeoutMs === undefined || timeoutMs <= 0) {
      await all;
      return this.registry.snapshot();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([all, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this.registry.snapshot();
  }

  /** Abort one worker. Returns `false` when unknown or already terminal. */
  stop(id: string): boolean {
    const slot = this.slots.get(id);
    const record = this.registry.get(id);
    if (!slot || !record) return false;
    if (record.status === "done" || record.status === "failed") return false;
    slot.controller.abort(new Error("stopped by coordinator"));
    return true;
  }

  /** Abort every active worker and wait for the resulting settlements. */
  async stopAll(): Promise<number> {
    let stopped = 0;
    for (const id of [...this.slots.keys()]) {
      if (this.stop(id)) stopped += 1;
    }
    await this.waitForAll();
    return stopped;
  }

  /** Coordinator-side send (from defaults to {@link coordinatorId}). */
  send(input: Omit<SendInput, "from"> & { from?: string }): MailboxMessage {
    return this.mailbox.send({ ...input, from: input.from ?? this.coordinatorId });
  }

  /** Coordinator-side reply to a worker's question. */
  reply(toWorkerId: string, body: string, subject?: string): MailboxMessage {
    return this.mailbox.send({
      from: this.coordinatorId,
      to: toWorkerId,
      type: "reply",
      subject,
      body,
    });
  }

  /** Block until a matching message is deliverable (or the timeout elapses). */
  waitFor(
    types?: MailboxMessageType[],
    timeoutMs = 30_000,
    filter?: MailboxFilter,
  ): Promise<MailboxMessage | null> {
    return this.mailbox.wait(types, timeoutMs, filter);
  }

  /** Snapshot of one worker's report (tokens, text, isolation stats). */
  report(id: string): WorkerReport | undefined {
    const report = this.reportMap.get(id);
    return report ? cloneReport(report) : undefined;
  }

  /** Snapshot of every report, insertion order. */
  reports(): WorkerReport[] {
    return [...this.reportMap.values()].map(cloneReport);
  }

  /** Aggregate every worker's usage into one ledger row. */
  usage(): WorkerUsageSummary {
    return summarizeUsage(this.reports().flatMap((r) => r.usages));
  }

  /** Stop accepting callbacks and drop mailbox waiters. */
  dispose(): void {
    this.unsubscribeMailbox?.();
    this.unsubscribeMailbox = undefined;
    this.mailbox.dispose();
  }

  /* -------------------------------------------------------------- internals */

  private async runWorker(
    spec: ResolvedWorkerSpec,
    worker: WorkerAgent,
    controller: AbortController,
  ): Promise<void> {
    const usages: Usage[] = [];
    let text = "";
    let steps = 0;
    let toolCalls = 0;
    let error: string | undefined;

    try {
      for await (const event of worker.run(controller.signal)) {
        switch (event.type) {
          case "assistant.message": {
            steps += 1;
            const content = event.message.content;
            if (
              event.message.role === "assistant" &&
              typeof content === "string" &&
              content.trim().length > 0
            ) {
              text = content;
            }
            break;
          }
          case "tool.call":
            toolCalls += 1;
            break;
          case "usage":
            usages.push(event.usage);
            break;
          case "turn.end":
            if (event.reason === "error") {
              error = event.error ?? "worker turn ended with error";
            } else if (event.reason === "aborted") {
              error = "worker stopped";
            } else if (event.reason === "max_steps") {
              error = error ?? "worker hit max_steps";
            }
            break;
          default:
            break;
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const report: WorkerReport = {
      id: spec.id,
      sessionId: worker.sessionId ?? spec.id,
      text: text.trim(),
      usages,
      summary: summarizeUsage(usages),
      steps,
      toolCalls,
      messageCount: worker.messages ? worker.messages().length : 0,
      error,
    };
    this.reportMap.set(spec.id, report);

    const status: WorkerStatus = error ? "failed" : "done";
    this.registry.update(
      spec.id,
      {
        status,
        result: report.text,
        error,
        endedAt: this.now(),
      },
      error ? "worker failed" : "worker finished",
    );

    // Completion notice for the coordinator. Sent even on failure so a
    // `wait_for(["worker_done"])` never hangs on a crashed worker.
    this.mailbox.send({
      from: spec.id,
      to: this.coordinatorId,
      type: "worker_done",
      subject: spec.name,
      body: report.text.length > 0
        ? report.text
        : error
          ? `failed: ${error}`
          : "(worker produced no final text)",
    });
  }
}

function cloneReport(report: WorkerReport): WorkerReport {
  return {
    ...report,
    usages: report.usages.map((u) => ({ ...u })),
    summary: { ...report.summary },
  };
}
