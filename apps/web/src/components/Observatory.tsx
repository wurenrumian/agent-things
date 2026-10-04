import { useMemo, useState } from "react";
import { ContextTab } from "./ContextTab";
import { RequestTab } from "./RequestTab";
import { UsageTab } from "./UsageTab";
import { TimelineTab } from "./TimelineTab";
import { DiffTab, collectDiffs } from "./DiffTab";
import { ForensicsTab } from "./ForensicsTab";
import { LabsTab } from "./LabsTab";
import { LearnTab } from "./LearnTab";
import { collectForensics } from "../forensics";
import type { AgentEvent, Mechanisms } from "../types";

type TabId =
  | "context"
  | "request"
  | "usage"
  | "timeline"
  | "diff"
  | "forensics"
  | "labs"
  | "learn";

const TABS: { id: TabId; label: string }[] = [
  { id: "context", label: "Context" },
  { id: "request", label: "Request" },
  { id: "usage", label: "Usage" },
  { id: "timeline", label: "Timeline" },
  { id: "labs", label: "Labs" },
  { id: "learn", label: "Learn" },
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
  const forensics = useMemo(() => collectForensics(events), [events]);

  // The Diff tab only appears once a write turn has produced a patch, so a
  // read-only session looks exactly as it did before M8. Forensics appears as
  // soon as a second request exists to diff against.
  const tabs: { id: TabId; label: string }[] = [...TABS];
  if (diffCount > 0) tabs.push({ id: "diff", label: "Diff" });
  if (forensics.requestCount >= 2) tabs.push({ id: "forensics", label: "Forensics" });

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
            {id === "forensics" && forensics.pairs.length > 0 && (
              <span className="tab-count">{forensics.pairs.length}</span>
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
        {tab === "forensics" && <ForensicsTab events={events} />}
        {tab === "labs" && <LabsTab />}
        {tab === "learn" && <LearnTab onOpenLabs={() => setTab("labs")} />}
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
