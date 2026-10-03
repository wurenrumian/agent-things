import {
  buildSystemPrompt,
  toContextSections,
  type SystemPrompt,
} from "../context/system-prompt.js";
import { estimateTokens, messageText, withCacheBreakpoint } from "../content.js";
import type {
  AgentEvent,
  ContextBreakdown,
  TurnEndReason,
} from "../events.js";
import { decidePermission, type PermissionMode } from "../permissions.js";
import type { OpenRouterClient } from "../provider/openrouter.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ChatMessage, ToolCall, UserMessage } from "../types.js";

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

    const userMessage: UserMessage = { role: "user", content: input };
    this.messages.push(userMessage);

    const maxSteps = this.config.maxSteps ?? 24;
    const permissionMode = this.config.permissionMode ?? "yolo";

    try {
      const prompt = await this.systemPrompt();

      for (let step = 0; step < maxSteps; step++) {
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
          yield* this.executeToolCall(call, permissionMode, signal);
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

  private async *executeToolCall(
    call: ToolCall,
    mode: PermissionMode,
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

    const { decision, reason } = decidePermission(mode, tool);
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

    const startedAt = Date.now();
    let output: string;
    let isError = false;
    let events: AgentEvent[] = [];
    try {
      const result = await tool.execute(input, { cwd: this.config.cwd, signal });
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
