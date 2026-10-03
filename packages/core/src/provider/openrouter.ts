import type {
  AssistantMessage,
  ChatMessage,
  ChatRequest,
  ToolCall,
  ToolSchema,
  Usage,
} from "../types.js";

/**
 * A deliberately thin, hand-written OpenRouter client.
 *
 * Why hand-written instead of an SDK: the whole point of this project is to see
 * the request body that actually goes over the wire — the message array, the
 * tool schemas, the cache breakpoints, the usage numbers. An SDK hides exactly
 * the thing we want to study.
 *
 * Endpoint is OpenAI chat-completions compatible:
 *   POST https://openrouter.ai/api/v1/chat/completions
 */

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl?: string;
  /** OpenRouter attribution headers (optional). */
  referer?: string;
  title?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export interface ChatStreamOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  /** Enables OpenRouter provider sticky-routing for prompt-cache hits. */
  sessionId?: string;
  signal?: AbortSignal;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

export interface ChatStreamCallbacks {
  /** Fired with the exact request body, before it is sent. */
  onRequest?(body: ChatRequest): void;
  onText?(delta: string): void;
  onToolCall?(delta: ToolCallDelta): void;
}

export interface ChatStreamResult {
  message: AssistantMessage;
  usage?: Usage;
  finishReason?: string;
  /** The exact body we sent. Surfaced to the observatory. */
  body: ChatRequest;
}

interface RawDelta {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface RawChunk {
  choices?: Array<{
    delta?: RawDelta;
    finish_reason?: string | null;
  }>;
  usage?: Usage;
  error?: { message?: string; code?: number };
}

export class OpenRouterClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly referer?: string;
  private readonly title?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenRouterConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? "https://openrouter.ai/api/v1").replace(
      /\/$/,
      "",
    );
    this.referer = config.referer;
    this.title = config.title;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /**
   * Stream a completion. Accumulates text + tool calls, invokes callbacks as
   * deltas arrive, and returns the assembled assistant message plus usage.
   */
  async chatStream(
    opts: ChatStreamOptions,
    cb: ChatStreamCallbacks = {},
  ): Promise<ChatStreamResult> {
    const body: ChatRequest = {
      model: opts.model,
      messages: opts.messages,
      stream: true,
      // OpenRouter returns usage in the final chunk; include_usage is harmless
      // and required by a few OpenAI-compatible routes.
      stream_options: { include_usage: true },
    };
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools;
      body.tool_choice = "auto";
    }
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
    if (opts.sessionId) body.session_id = opts.sessionId;

    cb.onRequest?.(body);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.referer) headers["HTTP-Referer"] = this.referer;
    if (this.title) headers["X-Title"] = this.title;

    const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `OpenRouter request failed: ${res.status} ${res.statusText} ${text}`.trim(),
      );
    }

    let text = "";
    let usage: Usage | undefined;
    let finishReason: string | undefined;
    /** Tool calls arrive fragmented; keyed by index, in arrival order. */
    const toolCalls = new Map<number, ToolCall>();

    const readSse = async (): Promise<void> => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by a blank line.
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          this.handleSseEvent(rawEvent, (chunk) => {
            if (chunk.usage) usage = chunk.usage;
            const choice = chunk.choices?.[0];
            if (!choice) return;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice.delta;
            if (!delta) return;

            if (typeof delta.content === "string" && delta.content.length > 0) {
              text += delta.content;
              cb.onText?.(delta.content);
            }
            for (const tc of delta.tool_calls ?? []) {
              const existing = toolCalls.get(tc.index) ?? {
                id: tc.id ?? "",
                type: "function" as const,
                function: { name: "", arguments: "" },
              };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.function.name += tc.function.name;
              if (tc.function?.arguments) {
                existing.function.arguments += tc.function.arguments;
              }
              toolCalls.set(tc.index, existing);
              cb.onToolCall?.({
                index: tc.index,
                id: tc.id,
                name: tc.function?.name,
                argumentsDelta: tc.function?.arguments,
              });
            }
          });
        }
      }
    };

    await readSse();

    const message: AssistantMessage = {
      role: "assistant",
      content: text.length > 0 ? text : null,
    };
    if (toolCalls.size > 0) {
      message.tool_calls = [...toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => v);
    }

    return { message, usage, finishReason, body };
  }

  private handleSseEvent(rawEvent: string, onChunk: (chunk: RawChunk) => void) {
    for (const line of rawEvent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "" || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as RawChunk;
        if (parsed.error) {
          throw new Error(parsed.error.message ?? "provider error");
        }
        onChunk(parsed);
      } catch (err) {
        // Ignore keep-alive / non-JSON comments; surface real provider errors.
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
  }
}
