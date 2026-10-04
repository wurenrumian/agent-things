import { useMemo, useState } from "react";
import { ContextTab } from "./ContextTab";
import { RequestTab } from "./RequestTab";
import { UsageTab } from "./UsageTab";
import { TimelineTab } from "./TimelineTab";
import { DiffTab, collectDiffs } from "./DiffTab";
import type { AgentEvent, Mechanisms } from "../types";

type TabId = "context" | "request" | "usage" | "timeline" | "diff";

const TABS: { id: TabId; label: string }[] = [
  { id: "context", label: "Context" },
  { id: "request", label: "Request" },
  { id: "usage", label: "Usage" },
  { id: "timeline", label: "Timeline" },
];

interface ObservatoryProps {
  events: AgentEvent[];
  mechanisms: Mechanisms | null;
}

/** The right pane: everything the event stream tells us about one turn. */
export function Observatory({ events, mechanisms }: ObservatoryProps) {
  const [tab, setTab] = useState<TabId>("context");

  const contextEvent = useMemo(
    () => lastOfType(events, "context.compiled"),
    [events],
  );
  const requestEvent = useMemo(() => lastOfType(events, "request.sent"), [events]);
  const usageCount = events.filter((e) => e.type === "usage").length;
  const diffCount = useMemo(() => collectDiffs(events).length, [events]);

  // The Diff tab only appears once a write turn has produced a patch, so a
  // read-only session looks exactly as it did before M8.
  const tabs = diffCount > 0 ? [...TABS, { id: "diff" as const, label: "Diff" }] : TABS;

  return (
    <section className="observatory">
      <MechanismStrip mechanisms={mechanisms} />
      <nav className="tabs" role="tablist" aria-label="Context observatory">
        {tabs.map(({ id, label }) => (
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
            {id === "diff" && diffCount > 0 && (
              <span className="tab-count">{diffCount}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="tab-content" role="tabpanel">
        {tab === "context" && <ContextTab event={contextEvent} />}
        {tab === "request" && <RequestTab event={requestEvent} />}
        {tab === "usage" && <UsageTab events={events} />}
        {tab === "timeline" && <TimelineTab events={events} />}
        {tab === "diff" && <DiffTab events={events} />}
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

/** Compact summary of what the server composed at boot (`/api/mechanisms`). */
function MechanismStrip({ mechanisms }: { mechanisms: Mechanisms | null }) {
  if (!mechanisms) return null;
  return (
    <div className="mechanism-strip" title="Loaded from GET /api/mechanisms">
      <span className="mechanism-item">
        <span className="mechanism-label">skills</span>
        <span className="mechanism-value">
          {joinList(mechanisms.skills)}
        </span>
      </span>
      <span className="mechanism-item">
        <span className="mechanism-label">mcp</span>
        <span className="mechanism-value">
          {joinList(mechanisms.mcpServers)}
        </span>
      </span>
      <span className="mechanism-item">
        <span className="mechanism-label">tools</span>
        <span className="mechanism-value">{mechanisms.tools.length}</span>
      </span>
      <span
        className="mechanism-item"
        title={mechanisms.memory?.dir ?? "MEMORY_ENABLED unset"}
      >
        <span className="mechanism-label">memory</span>
        <span className="mechanism-value">
          {mechanisms.memory?.enabled
            ? `${mechanisms.memory.count ?? 0} entries${
                mechanisms.memory.systemInject ? " · sys" : ""
              }`
            : "off"}
        </span>
      </span>
      <span className="mechanism-item">
        <span className="mechanism-label">workers</span>
        <span className="mechanism-value">
          {mechanisms.orchestrator?.enabled
            ? `${mechanisms.orchestrator.workers ?? 0}`
            : "off"}
        </span>
      </span>
      <span className="mechanism-item">
        <span className="mechanism-label">tool search</span>
        <span className="mechanism-value">
          {mechanisms.toolSearch?.enabled ? "on" : "off"}
        </span>
      </span>
    </div>
  );
}

function joinList(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "—";
}
