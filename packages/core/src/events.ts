import type { ChatMessage, ChatRequest, Usage } from "./types.js";

/** A labelled chunk of the assembled system prompt (for the observatory). */
export interface ContextSection {
  name: string;
  chars: number;
  preview: string;
}

export interface ContextBreakdown {
  systemChars: number;
  messageCount: number;
  toolCount: number;
  estimatedTokens: number;
  sections: ContextSection[];
}

/**
 * A tool-gate verdict. `ask` means "a human/UI must resolve this"; the loop
 * echoes the *true* verdict on `permission.decision` even when it proceeds
 * optimistically in `yolo` mode.
 */
export type PermissionDecision = "allow" | "deny" | "ask";

export type TurnEndReason = "stop" | "max_steps" | "error" | "aborted";

/**
 * The single event vocabulary the whole system speaks. The agent emits these;
 * the server persists + streams them; the web renders them. Every mechanism we
 * study shows up here, which is what makes it observable.
 */
export type AgentEvent =
  | {
      type: "turn.start";
      sessionId: string;
      turnId: string;
      input: string;
      at: number;
    }
  | {
      type: "context.compiled";
      messages: ChatMessage[];
      tools: string[];
      breakdown: ContextBreakdown;
      at: number;
    }
  | { type: "request.sent"; model: string; body: ChatRequest; at: number }
  | { type: "text.delta"; text: string; at: number }
  | { type: "assistant.message"; message: ChatMessage; at: number }
  | {
      type: "permission.decision";
      toolCallId: string;
      name: string;
      decision: PermissionDecision;
      reason: string;
      at: number;
    }
  | {
      type: "tool.call";
      toolCallId: string;
      name: string;
      input: unknown;
      at: number;
    }
  | {
      type: "tool.result";
      toolCallId: string;
      name: string;
      output: string;
      isError: boolean;
      durationMs: number;
      at: number;
    }
  | { type: "usage"; usage: Usage; at: number }
  /**
   * Additive, mechanism-agnostic progress signal. A mechanism tool (skills,
   * MCP, subagent, …) attaches these to its `ToolResult.events`; the loop
   * yields them right after `tool.result`, so the observatory can show what a
   * mechanism did without the loop knowing anything about that mechanism.
   */
  | {
      type: "mechanism";
      name: string;
      phase: string;
      data?: unknown;
      at: number;
    }
  /**
   * M7 scheduler settlement. Emitted by the server when a scheduled task
   * finishes (outside any turn); shaped inline so `events.ts` never imports a
   * mechanism type. `kind` is limited to the scheduler's scheduled kinds.
   */
  | {
      type: "task.settled";
      taskId: string;
      name: string;
      kind: "one-shot" | "interval";
      status: "succeeded" | "failed" | "cancelled";
      result?: unknown;
      error?: string;
      run: number;
      at: number;
    }
  | { type: "turn.end"; reason: TurnEndReason; error?: string; at: number };
