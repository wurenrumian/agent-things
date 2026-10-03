import { useEffect, useRef } from "react";
import { contentToText } from "../format";
import type { AgentEvent, ChatMessage } from "../types";

interface ConversationProps {
  messages: ChatMessage[];
  streaming: string;
  toolNames: Record<string, string>;
}

export function Conversation({
  messages,
  streaming,
  toolNames,
}: ConversationProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, streaming]);

  const visible = messages.filter((m) => m.role !== "system");

  return (
    <div className="conversation">
      {visible.length === 0 && streaming === "" && (
        <p className="empty-note">
          No messages yet. Send one below and watch the right pane.
        </p>
      )}
      {visible.map((message, index) => (
        <MessageBubble
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          message={message}
          toolNames={toolNames}
        />
      ))}
      {streaming !== "" && (
        <div className="msg msg-assistant">
          <div className="msg-head">
            <span className="role role-assistant">assistant</span>
            <span className="msg-meta">streaming…</span>
          </div>
          <pre className="msg-body">{streaming}</pre>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function MessageBubble({
  message,
  toolNames,
}: {
  message: ChatMessage;
  toolNames: Record<string, string>;
}) {
  if (message.role === "assistant") {
    return (
      <div className="msg msg-assistant">
        <div className="msg-head">
          <span className="role role-assistant">assistant</span>
        </div>
        {message.content ? (
          <pre className="msg-body">{message.content}</pre>
        ) : (
          <p className="msg-hint">(no text — tool calls below)</p>
        )}
        {message.tool_calls?.map((call) => (
          <div className="tool-call" key={call.id}>
            <span className="tool-name">{call.function.name}</span>
            <code className="tool-args">{prettyArgs(call.function.arguments)}</code>
          </div>
        ))}
      </div>
    );
  }

  if (message.role === "tool") {
    const name = toolNames[message.tool_call_id] ?? "tool";
    return (
      <div className="msg msg-tool">
        <div className="msg-head">
          <span className="role role-tool">{name}</span>
          <span className="msg-meta">result</span>
        </div>
        <pre className="msg-body">{message.content}</pre>
      </div>
    );
  }

  return (
    <div className="msg msg-user">
      <div className="msg-head">
        <span className="role role-user">user</span>
      </div>
      <pre className="msg-body">{contentToText(message.content)}</pre>
    </div>
  );
}

function prettyArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Map toolCallId -> tool name from the event log, so tool results are labelled. */
export function buildToolNames(events: AgentEvent[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const event of events) {
    if (event.type === "tool.call") {
      names[event.toolCallId] = event.name;
    }
  }
  return names;
}
