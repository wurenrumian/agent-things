import { useMemo, useState } from "react";
import { ContextTab } from "./ContextTab";
import { RequestTab } from "./RequestTab";
import { UsageTab } from "./UsageTab";
import { TimelineTab } from "./TimelineTab";
import type { AgentEvent } from "../types";

type TabId = "context" | "request" | "usage" | "timeline";

const TABS: { id: TabId; label: string }[] = [
  { id: "context", label: "Context" },
  { id: "request", label: "Request" },
  { id: "usage", label: "Usage" },
  { id: "timeline", label: "Timeline" },
];

interface ObservatoryProps {
  events: AgentEvent[];
}

/** The right pane: everything the event stream tells us about one turn. */
export function Observatory({ events }: ObservatoryProps) {
  const [tab, setTab] = useState<TabId>("context");

  const contextEvent = useMemo(
    () => lastOfType(events, "context.compiled"),
    [events],
  );
  const requestEvent = useMemo(() => lastOfType(events, "request.sent"), [events]);
  const usageCount = events.filter((e) => e.type === "usage").length;

  return (
    <section className="observatory">
      <nav className="tabs" role="tablist" aria-label="Context observatory">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`tab${tab === id ? " tab-active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
            {id === "timeline" && events.length > 0 && (
              <span className="tab-count">{events.length}</span>
            )}
            {id === "usage" && usageCount > 0 && (
              <span className="tab-count">{usageCount}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="tab-content" role="tabpanel">
        {tab === "context" && <ContextTab event={contextEvent} />}
        {tab === "request" && <RequestTab event={requestEvent} />}
        {tab === "usage" && <UsageTab events={events} />}
        {tab === "timeline" && <TimelineTab events={events} />}
      </div>
    </section>
  );
}

function lastOfType<T extends AgentEvent["type"]>(
  events: AgentEvent[],
  type: T,
): Extract<AgentEvent, { type: T }> | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event && event.type === type) {
      return event as Extract<AgentEvent, { type: T }>;
    }
  }
  return undefined;
}
