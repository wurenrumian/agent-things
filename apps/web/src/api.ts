import type {
  AgentEvent,
  Mechanisms,
  SessionDetail,
  SessionMeta,
  StoredEvent,
} from "./types";

/**
 * Thin HTTP client for the M0 server. All paths are relative so the Vite dev
 * proxy (see `vite.config.ts`) forwards `/api` to http://localhost:8787.
 */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  return (await res.json()) as T;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // fall through to the status line
  }
  return `${res.status} ${res.statusText}`;
}

export function getMechanisms(): Promise<Mechanisms> {
  return request<Mechanisms>("/api/mechanisms");
}

export function listSessions(): Promise<SessionMeta[]> {
  return request<SessionMeta[]>("/api/sessions");
}

export function createSession(title?: string): Promise<SessionMeta> {
  return request<SessionMeta>("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(title ? { title } : {}),
  });
}

export function getSession(id: string): Promise<SessionDetail> {
  return request<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);
}

export async function getEvents(id: string): Promise<StoredEvent[]> {
  return request<StoredEvent[]>(
    `/api/sessions/${encodeURIComponent(id)}/events`,
  );
}

export interface CompactionResult {
  before: number;
  after: number;
  summarized: number;
  keptRecent: number;
  keptLeading: number;
  placement: string;
}

/** Force one compaction of a session's live history (M3). */
export function compactSession(id: string): Promise<CompactionResult> {
  return request<CompactionResult>(
    `/api/sessions/${encodeURIComponent(id)}/compact`,
    { method: "POST" },
  );
}

export interface StreamHandlers {
  onEvent: (event: AgentEvent) => void;
  onError?: (error: Error) => void;
  onDone?: () => void;
}

/**
 * POST a message and consume the SSE response with a `fetch` reader
 * (`EventSource` cannot POST).
 *
 * Each frame is `event: <type>\ndata: <JSON of the full AgentEvent>`; the
 * stream ends after `turn.end`. Resolves when the stream closes.
 */
export async function sendMessage(
  sessionId: string,
  input: string,
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({ input }),
        signal,
      },
    );
  } catch (err) {
    if (isAbort(err)) return;
    throw err;
  }

  if (!res.ok) throw new Error(await errorMessage(res));
  if (!res.body) throw new Error("response has no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = nextBoundary(buffer);
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
        const event = parseFrame(frame);
        if (event) {
          handlers.onEvent(event);
          if (event.type === "turn.end") {
            handlers.onDone?.();
            return;
          }
        }
        boundary = nextBoundary(buffer);
      }
    }
    // Stream closed without an explicit turn.end.
    handlers.onDone?.();
  } catch (err) {
    if (isAbort(err)) return;
    const error = err instanceof Error ? err : new Error(String(err));
    handlers.onError?.(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function nextBoundary(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

/** Parse one SSE frame; returns the event, or null for comments/keepalives. */
function parseFrame(frame: string): AgentEvent | null {
  const data: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    if (!rawLine.startsWith("data:")) continue;
    data.push(rawLine.slice("data:".length).replace(/^ /, ""));
  }
  if (data.length === 0) return null;
  const json = data.join("\n");
  try {
    return JSON.parse(json) as AgentEvent;
  } catch {
    return null;
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
