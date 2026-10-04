import { collectForensics } from "../forensics";
import type { ContextBlock, ForensicsPair } from "../forensics";
import { formatNumber, formatTime } from "../format";
import type { AgentEvent } from "../types";

/**
 * L1: the cache-forensics view. It pairs consecutive `request.sent` events (each
 * carries the full request body) and points at the **first divergent block** —
 * the block that decides the prefix-cache hit — plus the changed tools and the
 * `cached_tokens` before/after. Pure observability: it never feeds the model.
 */

const BLOCK_LABEL: Record<ContextBlock, string> = {
  none: "none (append-only)",
  system: "system",
  tools: "tools",
  messages: "messages",
};

export function ForensicsTab({ events }: { events: AgentEvent[] }) {
  const { pairs, requestCount } = collectForensics(events);

  if (requestCount === 0) {
    return (
      <p className="empty-note">
        No requests sent yet. Once a session sends two requests, the first
        divergent block of each consecutive pair shows up here.
      </p>
    );
  }

  if (pairs.length === 0) {
    return (
      <p className="empty-note">
        Only one request so far. Send another turn and the diff against it will
        name the block that decided (or preserved) the cache.
      </p>
    );
  }

  return (
    <div className="tab-body">
      <p className="fx-intro">
        Prefix-cache layout is <code>system</code> → <code>tools</code> →{" "}
        <code>messages</code>. The first block whose bytes differ is where the
        hit stops.
      </p>
      {pairs.map((pair) => (
        <PairCard key={pair.index} pair={pair} />
      ))}
    </div>
  );
}

function PairCard({ pair }: { pair: ForensicsPair }) {
  const { diff } = pair;
  const changed = diff.divergence !== "none";
  const toolChange =
    diff.tools.added.length + diff.tools.removed.length + (diff.tools.reordered ? 1 : 0);

  return (
    <section className={`fx-card${changed ? " fx-card-changed" : " fx-card-ok"}`}>
      <header className="fx-head">
        <span className="fx-pair">
          req #{pair.index + 1} → #{pair.index + 2}
        </span>
        <span className="fx-time">
          {formatTime(pair.prevAt)} → {formatTime(pair.at)}
        </span>
        <span className={`fx-verdict fx-verdict-${diff.divergence}`}>
          {BLOCK_LABEL[diff.divergence]}
        </span>
      </header>

      <div className="fx-body">
        <div className="fx-blocks" title="cacheable prefix, in serialization order">
          <BlockChip name="system" divergent={diff.divergence === "system"} />
          <span className="fx-arrow">→</span>
          <BlockChip name="tools" divergent={diff.divergence === "tools"} />
          <span className="fx-arrow">→</span>
          <BlockChip name="messages" divergent={diff.divergence === "messages"} />
        </div>

        <div className="fx-detail">
          <DetailLine
            label="system"
            value={
              diff.system.same
                ? `same · ${formatNumber(diff.system.prevLen)} chars`
                : `changed at byte ${formatNumber(diff.system.changedAt ?? 0)}`
            }
            changed={!diff.system.same}
          />
          <DetailLine
            label="tools"
            value={toolSummary(pair, toolChange)}
            changed={!diff.tools.same}
          />
          <DetailLine
            label="messages"
            value={messageSummary(pair)}
            changed={diff.messages.changedAt !== undefined}
          />
        </div>

        <div className="fx-cache" aria-label="cache before and after">
          <CacheStat label="cached before" value={pair.cachedBefore} />
          <span className="fx-arrow">→</span>
          <CacheStat label="cached after" value={pair.cachedAfter} />
          {pair.promptAfter !== null && (
            <span className="fx-prompt">
              / {formatNumber(pair.promptAfter)} prompt
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function BlockChip({ name, divergent }: { name: string; divergent: boolean }) {
  return (
    <span className={`fx-block${divergent ? " fx-block-divergent" : ""}`}>
      {divergent && <span className="fx-block-mark">◆</span>}
      {name}
    </span>
  );
}

function DetailLine({
  label,
  value,
  changed,
}: {
  label: string;
  value: string;
  changed: boolean;
}) {
  return (
    <div className={`fx-detail-line${changed ? " fx-detail-changed" : ""}`}>
      <span className="fx-detail-label">{label}</span>
      <span className="fx-detail-value">{value}</span>
    </div>
  );
}

function CacheStat({ label, value }: { label: string; value: number | null }) {
  return (
    <span className={`fx-cache-stat${value && value > 0 ? " fx-cache-hit" : ""}`}>
      <span className="fx-cache-label">{label}</span>
      <span className="fx-cache-value">
        {value === null ? "—" : formatNumber(value)}
      </span>
    </span>
  );
}

function toolSummary(pair: ForensicsPair, changeCount: number): string {
  if (pair.diff.tools.same) return "same · order preserved";
  const parts: string[] = [];
  if (pair.diff.tools.reordered) parts.push("reordered");
  if (pair.diff.tools.added.length > 0)
    parts.push(`+${pair.diff.tools.added.join(", ")}`);
  if (pair.diff.tools.removed.length > 0)
    parts.push(`−${pair.diff.tools.removed.join(", ")}`);
  if (parts.length === 0) parts.push(`${changeCount} schema change(s)`);
  return parts.join(" · ");
}

function messageSummary(pair: ForensicsPair): string {
  const { messages } = pair.diff;
  if (messages.appended > 0) {
    return `append-only · +${messages.appended} turn(s), prefix intact`;
  }
  if (messages.changedAt !== undefined) {
    return `edited at turn ${messages.changedAt} · prefix ${messages.prefixLen} kept`;
  }
  return "same";
}
