/**
 * Wire types. Deliberately close to the OpenAI chat-completions shape because
 * that is exactly what OpenRouter speaks. Keeping them close means the
 * observatory can show the *literal* request body — no magic translation layer.
 */

/** Anthropic-style explicit cache breakpoint, passed through by OpenRouter. */
export interface CacheControl {
  type: "ephemeral";
}

export interface TextPart {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export type ContentPart = TextPart;

/** A message body: either a plain string or a list of typed parts. */
export type Content = string | ContentPart[];

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-encoded arguments, as sent on the wire. */
    arguments: string;
  };
}

export interface FunctionDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** The tool schema as it appears in the request body. */
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

/** Usage as reported by OpenRouter (superset of OpenAI). */
export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    /** Tokens served from the provider prompt cache (cheap). */
    cached_tokens?: number;
    /** Tokens written into the cache this call (Anthropic). */
    cache_write_tokens?: number;
  };
  /** OpenRouter-reported credit cost for this call, when present. */
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
  /**
   * OpenRouter extension: sticky-routes requests so the same provider serves
   * the same session, which is a prerequisite for prompt-cache hits.
   */
  session_id?: string;
}

/** Plain JSON Schema object for tool parameters. */
export type JSONSchema = Record<string, unknown>;
