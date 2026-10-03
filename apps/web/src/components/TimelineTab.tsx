import { contentToText, formatTime } from "../format";
import { JsonView } from "./JsonView";
import type { AgentEvent } from "../types";

interface TimelineTabProps {
  events: AgentEvent[];
}

export function TimelineTab({ events }: TimelineTabProps) {
  if (events.length === 0) {
    return (
      <p className="empty-note">
        The event log is empty. Every agent event lands here in arrival order.
      </p>
    );
  }

  return (
    <div className="tab-body">
      <div className="timeline" role="log">
        {events.map((event, index) => (
          <TimelineRow key={index} event={event} index={index} />
        ))}
      </div>
    </div>
  );
}

function TimelineRow({ event, index }: { event: AgentEvent; index: number }) {
  return (
    <details className={`tl-row tl-${event.type.replace(".", "-")}`}>
      <summary className="tl-summary">
        <span className="tl-seq">{String(index).padStart(3, "0")}</span>
        <span className="tl-time">{formatTime(event.at)}</span>
        <span className="tl-type" data-type={event.type}>
          {event.type}
        </span>
        <span className="tl-brief">{summarize(event)}</span>
      </summary>
      <div className="tl-detail">
        <JsonView value={event} depth={0} defaultOpen={false} />
      </div>
    </details>
  );
}

function summarize(event: AgentEvent): string {
  switch (event.type) {
    case "turn.start":
      return `input: ${truncate(event.input)}`;
    case "context.compiled":
      return `${event.messages.length} msgs · ${event.tools.length} tools · ~${event.breakdown.estimatedTokens} tok`;
    case "request.sent":
      return `model ${event.model} · ${event.body.messages.length} msgs`;
    case "text.delta":
      return truncate(event.text);
    case "assistant.message":
      return truncate(contentToText(event.message.content ?? "(tool calls)"));
    case "permission.decision":
      return `${event.decision} ${event.name} — ${event.reason}`;
    case "tool.call":
      return `${event.name}(${truncate(JSON.stringify(event.input))})`;
    case "tool.result":
      return `${event.name} · ${event.isError ? "ERROR" : "ok"} · ${event.durationMs}ms · ${truncate(event.output)}`;
    case "usage":
      return `prompt ${event.usage.prompt_tokens ?? 0} · completion ${event.usage.completion_tokens ?? 0} · cached ${event.usage.prompt_tokens_details?.cached_tokens ?? 0}`;
    case "turn.end":
      return event.error ? `${event.reason}: ${event.error}` : event.reason;
    default:
      return "";
  }
}

function truncate(text: string, max = 80): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}
