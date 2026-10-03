import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createSession,
  getEvents,
  getMechanisms,
  getSession,
  listSessions,
  sendMessage,
} from "./api";
import { Conversation, buildToolNames } from "./components/Conversation";
import { Observatory } from "./components/Observatory";
import { SessionPicker } from "./components/SessionPicker";
import type { AgentEvent, ChatMessage, Mechanisms, SessionMeta } from "./types";

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [mechanisms, setMechanisms] = useState<Mechanisms | null>(null);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const loadTokenRef = useRef(0);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await listSessions();
      setSessions(list);
      return list;
    } catch (err) {
      setError(toMessage(err));
      return [];
    }
  }, []);

  const selectSession = useCallback(async (id: string) => {
    const token = ++loadTokenRef.current;
    setSelectedId(id);
    setStreaming("");
    setError(null);
    setLoading(true);
    try {
      const [detail, stored] = await Promise.all([getSession(id), getEvents(id)]);
      if (loadTokenRef.current !== token) return;
      setMessages(detail.messages);
      setEvents(stored.map((item) => item.event));
    } catch (err) {
      if (loadTokenRef.current === token) setError(toMessage(err));
    } finally {
      if (loadTokenRef.current === token) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setMechanisms(await getMechanisms());
      } catch {
        // The strip is optional; a missing endpoint must not block the app.
      }
      const list = await refreshSessions();
      const first = list[0];
      if (first) void selectSession(first.id);
    })();
  }, [refreshSessions, selectSession]);

  const handleNew = useCallback(async () => {
    try {
      const session = await createSession();
      await refreshSessions();
      await selectSession(session.id);
    } catch (err) {
      setError(toMessage(err));
    }
  }, [refreshSessions, selectSession]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!selectedId || text === "" || sending) return;

    setError(null);
    setInput("");
    setSending(true);
    setStreaming("");
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text } satisfies ChatMessage,
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await sendMessage(selectedId, text, controller.signal, {
        onEvent: (event) => {
          setEvents((prev) => [...prev, event]);
          applyLiveEvent(event, {
            setStreaming,
            setMessages,
          });
        },
        onError: (err) => setError(toMessage(err)),
      });
    } catch (err) {
      if (!isAbort(err)) setError(toMessage(err));
    } finally {
      abortRef.current = null;
      setSending(false);
      void refreshSessions();
    }
  }, [input, refreshSessions, selectedId, sending]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    setSending(false);
    setStreaming("");
  }, []);

  const toolNames = useMemo(() => buildToolNames(events), [events]);
  const selected = sessions.find((s) => s.id === selectedId);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">◉</span>
          <h1>Context Observatory</h1>
          <span className="brand-sub">agent-things · M0</span>
        </div>
        <div className="header-status">
          {selected ? (
            <>
              <span className="chip chip-session">{selected.title}</span>
              <span className="meta-note">{selected.cwd}</span>
            </>
          ) : (
            <span className="meta-note">no session selected</span>
          )}
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-ghost" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}

      <div className="app-body">
        <SessionPicker
          sessions={sessions}
          selectedId={selectedId}
          loading={loading}
          onSelect={(id) => void selectSession(id)}
          onNew={() => void handleNew()}
          onRefresh={() => void refreshSessions()}
        />

        <main className="conversation-pane">
          <Conversation
            messages={messages}
            streaming={streaming}
            toolNames={toolNames}
          />
          <form
            className="send-box"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSend();
            }}
          >
            <textarea
              className="send-input"
              placeholder={
                selectedId
                  ? "Ask the agent…  (Enter to send, Shift+Enter for newline)"
                  : "Create or pick a session first"
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              disabled={!selectedId || sending}
              rows={3}
            />
            <div className="send-actions">
              {sending ? (
                <button type="button" className="btn btn-danger" onClick={handleStop}>
                  ■ Stop
                </button>
              ) : (
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!selectedId || input.trim() === ""}
                >
                  Send ▶
                </button>
              )}
            </div>
          </form>
        </main>

        <Observatory events={events} mechanisms={mechanisms} />
      </div>
    </div>
  );
}

interface LiveSetters {
  setStreaming: (fn: (prev: string) => string) => void;
  setMessages: (fn: (prev: ChatMessage[]) => ChatMessage[]) => void;
}

/** Fold one streamed event into the live conversation view. */
function applyLiveEvent(event: AgentEvent, setters: LiveSetters): void {
  switch (event.type) {
    case "text.delta":
      setters.setStreaming((prev) => prev + event.text);
      break;
    case "assistant.message":
      setters.setMessages((prev) => [...prev, event.message]);
      setters.setStreaming(() => "");
      break;
    case "tool.result":
      setters.setMessages((prev) => [
        ...prev,
        {
          role: "tool",
          tool_call_id: event.toolCallId,
          content: event.output,
        } satisfies ChatMessage,
      ]);
      break;
    default:
      break;
  }
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
