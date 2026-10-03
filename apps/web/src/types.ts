/**
 * Local copy of the `@agent/core` wire types the observatory renders.
 *
 * The web app must not import `@agent/core` (it talks HTTP only), so the
 * shapes are mirrored here. They are intentionally identical to
 * `packages/core/src/types.ts` and `packages/core/src/events.ts`.
 */

/* ---------------------------------------------------------------- messages */

export interface CacheControl {
  type: "ephemeral";
}

export interface TextPart {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export type ContentPart = TextPart;

export type Content = string | ContentPart[];

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface FunctionDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ToolSchema {
  type: "function";
  function: FunctionDef;
}

export interface SystemMessage {
  role: "system";
  content: Content;
}
export interface UserMessage {
  role: "user";
  content: Content;
}
export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}
export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type ChatMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

/* ------------------------------------------------------------------- usage */

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  cost?: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  tool_choice?: "auto" | "none" | "required";
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  session_id?: string;
}

/* ------------------------------------------------------------------ events */

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

export type PermissionDecision = "allow" | "deny";

export type TurnEndReason = "stop" | "max_steps" | "error" | "aborted";

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
  | {
      type: "mechanism";
      name: string;
      phase: string;
      data?: unknown;
      at: number;
    }
  | { type: "turn.end"; reason: TurnEndReason; error?: string; at: number };

export type AgentEventType = AgentEvent["type"];

/** `GET /api/mechanisms` — what the composition root actually wired up. */
export interface Mechanisms {
  skills: string[];
  mcpServers: string[];
  tools: string[];
}

export type ContextEvent = Extract<AgentEvent, { type: "context.compiled" }>;
export type RequestEvent = Extract<AgentEvent, { type: "request.sent" }>;
export type UsageEvent = Extract<AgentEvent, { type: "usage" }>;
export type ToolCallEvent = Extract<AgentEvent, { type: "tool.call" }>;
export type TurnEndEvent = Extract<AgentEvent, { type: "turn.end" }>;

/* ------------------------------------------------------------------- store */

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface StoredEvent {
  seq: number;
  event: AgentEvent;
}

export interface SessionDetail {
  session: SessionMeta;
  messages: ChatMessage[];
}
