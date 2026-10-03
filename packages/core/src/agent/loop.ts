import {
  buildSystemPrompt,
  toContextSections,
  type SystemPrompt,
} from "../context/system-prompt.js";
import { estimateTokens, messageText, withCacheBreakpoint } from "../content.js";
import type {
  AgentEvent,
  ContextBreakdown,
  PermissionDecision,
  TurnEndReason,
} from "../events.js";
import { decidePermission, type PermissionMode } from "../permissions.js";
import type { OpenRouterClient } from "../provider/openrouter.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ChatMessage, ToolCall, UserMessage } from "../types.js";
import type { HookRunner } from "../mechanisms/hooks/runner.js";
import type { CheckpointStore } from "../mechanisms/checkpoint/index.js";

/**
 * The agent loop — the "L0" kernel.
 *
 * One turn is a state machine:
 *   compile context -> request -> (text | tool calls) -> [execute tools -> back
 *   to compile] -> stop.
 *
 * Everything the loop does is emitted as an `AgentEvent` so the outside world
 * (server, web) can observe it. The loop owns the message array; it never
 * mutates history in place, only appends — which is what keeps the prompt-cache
 * prefix intact across steps.
 */

/**
 * The request a {@link AgentConfig.gate} is asked to rule on. The gate is the
 * M6 seam: it replaces the coarse `decidePermission(mode, tool)` with a policy +
 * hooks decision that may also rewrite `input`.
 */
export interface GateRequest {
  tool: string;
  input: Record<string, unknown>;
  turnId: string;
}

/**
 * A gate's verdict. `input` is what the tool is executed with — hook mutations
 * ride here. `records`/`mutated` are optional observability the loop relays as
 * a `mechanism` event; a gate that does not set them still works.
 */
export interface GateResult {
  decision: PermissionDecision;
  reason: string;
  input: Record<string, unknown>;
  /** Ordered audit trace from the policy/hooks (rendered as `mechanism`). */
  records?: unknown[];
  /** True when the gate rewrote `input`. */
  mutated?: boolean;
}

/**
 * Automatic compaction (M3). `compact` folds the current history into a new
 * array and reports what it did in `info`; `instructions` carries the text a
 * `preCompact` hook injected for the summarizer.
 */
export interface AgentCompactor {
  thresholdTokens: number;
  compact(
    messages: ChatMessage[],
    instructions?: string,
  ): Promise<{ messages: ChatMessage[]; info: Record<string, unknown> }>;
}

/** Observability payload for one compaction (returned by `compactNow`). */
export interface CompactionReport {
  before: number;
  after: number;
  summarized: number;
  keptRecent: number;
  keptLeading: number;
  placement: string;
  /** `preCompact` hook records, when hooks are configured. */
  records?: unknown[];
}

export interface AgentConfig {
  client: OpenRouterClient;
  model: string;
  tools: ToolRegistry;
  cwd: string;
  permissionMode?: PermissionMode;
  maxSteps?: number;
  temperature?: number;
  /** Replace the assembled system prompt entirely (for experiments). */
  systemPromptOverride?: string;
  platform?: string;
  /**
   * M6 tool gate. When set it replaces `decidePermission`; the returned `input`
   * is what the tool executes with. Absent ⇒ the original mode gate, unchanged.
   */
  gate?: (req: GateRequest) => Promise<GateResult>;
  /**
   * M6 lifecycle hooks. Drives the text points (`userPromptSubmit`,
   * `preCompact`) and the observational `postToolUse`.
   */
  hooks?: HookRunner;
  /** M3 automatic compaction. Absent ⇒ history is never folded. */
  compaction?: AgentCompactor;
  /**
   * M6 file checkpoints. When set it is handed to every tool call's
   * `ToolContext.checkpoints`, so a wrapped write tool can snapshot the file
   * before mutating it. Absent ⇒ no snapshotting (the default).
   */
  checkpoints?: CheckpointStore;
}

export interface AgentSnapshot {
  sessionId: string;
  messages: ChatMessage[];
}

export class Agent {
  readonly sessionId: string;
  messages: ChatMessage[];
  private readonly config: AgentConfig;
  private prompt: SystemPrompt | null = null;
  private turnCounter = 0;

  constructor(config: AgentConfig, sessionId: string, messages?: ChatMessage[]) {
    this.config = config;
    this.sessionId = sessionId;
    this.messages = messages ?? [];
  }

  snapshot(): AgentSnapshot {
    return { sessionId: this.sessionId, messages: this.messages };
  }

  private async systemPrompt(): Promise<SystemPrompt> {
    if (this.prompt) return this.prompt;
    if (this.config.systemPromptOverride) {
      this.prompt = {
        text: this.config.systemPromptOverride,
        sections: [
          {
            name: "override",
            content: this.config.systemPromptOverride,
            stable: true,
          },
        ],
      };
      return this.prompt;
    }
    this.prompt = await buildSystemPrompt({
      cwd: this.config.cwd,
      platform: this.config.platform,
    });
    return this.prompt;
  }

  async *run(input: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const startedAt = Date.now();
    const turnId = `${this.sessionId}-t${++this.turnCounter}`;
    const emit = (e: AgentEvent) => e;
    yield emit({
      type: "turn.start",
      sessionId: this.sessionId,
      turnId,
      input,
      at: startedAt,
    });

    // M6: `userPromptSubmit` hooks may rewrite the text before it enters the
    // model. Off unless a HookRunner is configured, so the smoke path is
    // byte-for-byte unchanged.
    let promptInput = input;
    if (this.config.hooks) {
      const { text, result } = await this.config.hooks.runText(
        "userPromptSubmit",
        input,
        turnId,
      );
      promptInput = text;
      yield emit({
        type: "mechanism",
        name: "hooks",
        phase: "userPromptSubmit",
        data: { records: result.records },
        at: Date.now(),
      });
    }

    const userMessage: UserMessage = { role: "user", content: promptInput };
    this.messages.push(userMessage);

    const maxSteps = this.config.maxSteps ?? 24;
    const permissionMode = this.config.permissionMode ?? "yolo";

    try {
      const prompt = await this.systemPrompt();

      for (let step = 0; step < maxSteps; step++) {
        // M3: at the top of each step (at most once), fold history when its
        // estimated size exceeds the configured threshold.
        if (this.config.compaction) {
          const before = this.estimateHistoryTokens();
          if (before > this.config.compaction.thresholdTokens) {
            const report = await this.compactHistory(turnId);
            if (report.records) {
              yield emit({
                type: "mechanism",
                name: "hooks",
                phase: "preCompact",
                data: { records: report.records },
                at: Date.now(),
              });
            }
            yield emit({
              type: "mechanism",
              name: "compaction",
              phase: "compacted",
              data: report,
              at: Date.now(),
            });
          }
        }

        const requestMessages = this.compileMessages(prompt);
        yield emit({
          type: "context.compiled",
          messages: requestMessages,
          tools: this.config.tools.list().map((t) => t.name),
          breakdown: buildBreakdown(prompt, requestMessages, this.config.tools),
          at: Date.now(),
        });

        const result = await this.config.client.chatStream(
          {
            model: this.config.model,
            messages: requestMessages,
            tools: this.config.tools.schemas(),
            temperature: this.config.temperature,
            sessionId: this.sessionId,
            signal,
          },
          {
            onRequest: (body) =>
              emit({
                type: "request.sent",
                model: body.model,
                body,
                at: Date.now(),
              }),
            onText: (delta) =>
              emit({ type: "text.delta", text: delta, at: Date.now() }),
          },
        );

        this.messages.push(result.message);
        yield emit({
          type: "assistant.message",
          message: result.message,
          at: Date.now(),
        });
        if (result.usage) {
          yield emit({ type: "usage", usage: result.usage, at: Date.now() });
        }

        const toolCalls = result.message.tool_calls ?? [];
        if (toolCalls.length === 0) {
          yield emit({ type: "turn.end", reason: "stop", at: Date.now() });
          return;
        }

        for (const call of toolCalls) {
          yield* this.executeToolCall(call, permissionMode, turnId, signal);
        }
      }

      yield emit({
        type: "turn.end",
        reason: "max_steps" satisfies TurnEndReason,
        at: Date.now(),
      });
    } catch (err) {
      const aborted =
        signal?.aborted ||
        (err instanceof Error && err.name === "AbortError");
      yield emit({
        type: "turn.end",
        reason: aborted ? "aborted" : "error",
        error: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      });
    }
  }

  /** The message array actually sent: system first, then append-only history. */
  private compileMessages(prompt: SystemPrompt): ChatMessage[] {
    return [
      { role: "system", content: withCacheBreakpoint(prompt.text) },
      ...this.messages,
    ];
  }

  /** Coarse estimate of the live history's size (display heuristic). */
  private estimateHistoryTokens(): number {
    return estimateTokens(this.messages.map((m) => messageText(m)).join("\n"));
  }

  /**
   * Force one compaction of the live history now. Returns the observability
   * report, or `null` when compaction is not configured. Additive API used by
   * `POST /api/sessions/:id/compact`.
   */
  async compactNow(): Promise<CompactionReport | null> {
    if (!this.config.compaction) return null;
    return this.compactHistory();
  }

  /**
   * Run the `preCompact` hooks (if any) for their summarizer instructions, fold
   * the history through the configured compactor, replace `this.messages`, and
   * report before/after token estimates.
   */
  private async compactHistory(turnId?: string): Promise<CompactionReport> {
    const compaction = this.config.compaction!;
    const before = this.estimateHistoryTokens();

    let instructions: string | undefined;
    let records: unknown[] | undefined;
    if (this.config.hooks) {
      const { text, result } = await this.config.hooks.runText(
        "preCompact",
        "",
        turnId,
      );
      instructions = text;
      records = result.records;
    }

    const { messages, info } = await compaction.compact(
      this.messages,
      instructions,
    );
    this.messages = messages;
    const after = this.estimateHistoryTokens();

    const number = (value: unknown, fallback = 0): number =>
      typeof value === "number" && Number.isFinite(value) ? value : fallback;

    return {
      before,
      after,
      summarized: number(info["summarized"]),
      keptRecent: number(info["keptRecent"]),
      keptLeading: number(info["keptLeading"]),
      placement:
        typeof info["placement"] === "string" ? info["placement"] : "spliced",
      records,
    };
  }

  private async *executeToolCall(
    call: ToolCall,
    mode: PermissionMode,
    turnId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    let input: Record<string, unknown> = {};
    try {
      input = call.function.arguments
        ? (JSON.parse(call.function.arguments) as Record<string, unknown>)
        : {};
    } catch {
      // fall through with empty input; tool will report the error
    }

    yield {
      type: "tool.call",
      toolCallId: call.id,
      name: call.function.name,
      input,
      at: Date.now(),
    };

    const tool = this.config.tools.get(call.function.name);
    if (!tool) {
      const reason = `unknown tool: ${call.function.name}`;
      yield {
        type: "permission.decision",
        toolCallId: call.id,
        name: call.function.name,
        decision: "deny",
        reason,
        at: Date.now(),
      };
      this.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: `Error: ${reason}`,
      });
      return;
    }

    // The M6 gate (policy + hooks) replaces the coarse mode gate when set; its
    // returned `input` is what the tool actually executes with.
    let decision: PermissionDecision;
    let reason: string;
    let executedInput = input;
    let gateTrace: unknown[] | undefined;
    let gateMutated: boolean | undefined;
    if (this.config.gate) {
      const gate = await this.config.gate({
        tool: tool.name,
        input,
        turnId,
      });
      decision = gate.decision;
      reason = gate.reason;
      executedInput = gate.input;
      gateTrace = gate.records;
      gateMutated = gate.mutated;
      yield {
        type: "mechanism",
        name: "hooks",
        phase: "preToolUse",
        data: {
          records: gateTrace ?? [],
          mutated: gateMutated ?? false,
          input: executedInput,
        },
        at: Date.now(),
      };
    } else {
      const outcome = decidePermission(mode, tool);
      decision = outcome.decision;
      reason = outcome.reason;
    }

    yield {
      type: "permission.decision",
      toolCallId: call.id,
      name: tool.name,
      decision,
      reason,
      at: Date.now(),
    };

    if (decision === "deny") {
      this.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: `Denied: ${reason}`,
      });
      return;
    }

    // `ask` is a pending approval. Non-interactively we cannot wait for a
    // human, so only `yolo` proceeds; the event above still records the true
    // verdict either way.
    if (decision === "ask" && mode !== "yolo") {
      this.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: `Blocked: pending approval (non-interactive) — ${reason}`,
      });
      return;
    }

    const startedAt = Date.now();
    let output: string;
    let isError = false;
    let events: AgentEvent[] = [];
    try {
      const result = await tool.execute(executedInput, {
        cwd: this.config.cwd,
        signal,
        turnId,
        sessionId: this.sessionId,
        checkpoints: this.config.checkpoints,
      });
      output = result.output;
      isError = result.isError ?? false;
      events = result.events ?? [];
    } catch (err) {
      output = err instanceof Error ? err.message : String(err);
      isError = true;
    }

    yield {
      type: "tool.result",
      toolCallId: call.id,
      name: tool.name,
      output,
      isError,
      durationMs: Date.now() - startedAt,
      at: Date.now(),
    };

    // Mechanism tools surface progress through `ToolResult.events`; the loop
    // just relays them in order. Purely additive: builtins return none.
    for (const event of events) yield event;

    // M6: `postToolUse` is observational — it may audit/redact in its own
    // record but cannot change the tool output.
    if (this.config.hooks) {
      const run = await this.config.hooks.run("postToolUse", {
        event: "postToolUse",
        tool: tool.name,
        input: executedInput,
        turnId,
      });
      yield {
        type: "mechanism",
        name: "hooks",
        phase: "postToolUse",
        data: { records: run.records },
        at: Date.now(),
      };
    }

    this.messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: isError ? `Error: ${output}` : output,
    });
  }
}

/** Cheap, display-only estimate of the context size + composition. */
function buildBreakdown(
  prompt: SystemPrompt,
  messages: ChatMessage[],
  tools: ToolRegistry,
): ContextBreakdown {
  const systemChars = prompt.text.length;
  const allText = messages.map((m) => messageText(m)).join("\n");
  return {
    systemChars,
    messageCount: messages.length,
    toolCount: tools.list().length,
    estimatedTokens: estimateTokens(allText) + estimateTokens(systemChars.toString()),
    sections: toContextSections(prompt),
  };
}
