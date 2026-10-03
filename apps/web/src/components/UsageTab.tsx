import {
  cacheHitRate,
  cachedTokens,
  cacheWriteTokens,
  formatCost,
  formatNumber,
  formatPercent,
  totalsCacheHitRate,
  usageTotals,
} from "../format";
import type { UsageTotals } from "../format";
import type { AgentEvent, Usage } from "../types";

interface UsageTabProps {
  events: AgentEvent[];
}

/** Cumulative cache hit rate and spend after each call, in call order. */
interface RunningPoint {
  rate: number;
  cost: number;
}

/**
 * Running session totals: for call *i*, `rate` is sum(cached)/sum(prompt) over
 * calls 1..i and `cost` is the accumulated spend so far. This is what makes the
 * cache economics visible at a glance as the session progresses.
 */
function runningSeries(usages: Usage[]): RunningPoint[] {
  let prompt = 0;
  let cached = 0;
  let cost = 0;
  return usages.map((u) => {
    prompt += u.prompt_tokens ?? 0;
    cached += cachedTokens(u);
    cost += u.cost ?? 0;
    return { rate: prompt > 0 ? cached / prompt : 0, cost };
  });
}

/** Usage after the most recent `turn.start` belongs to the current turn. */
function splitByTurn(events: AgentEvent[]): { turn: Usage[]; all: Usage[] } {
  const all: Usage[] = [];
  let lastTurnStart = -1;
  events.forEach((event, index) => {
    if (event.type === "turn.start") lastTurnStart = index;
    if (event.type === "usage") all.push(event.usage);
  });
  const turn = events
    .slice(lastTurnStart + 1)
    .filter((e): e is Extract<AgentEvent, { type: "usage" }> => e.type === "usage")
    .map((e) => e.usage);
  return { turn, all };
}

export function UsageTab({ events }: UsageTabProps) {
  const { turn, all } = splitByTurn(events);

  if (all.length === 0) {
    return (
      <p className="empty-note">
        No usage reported yet. Token and cache numbers show up here.
      </p>
    );
  }

  const turnTotals = usageTotals(turn);
  const sessionTotals = usageTotals(all);
  const running = runningSeries(all);

  return (
    <div className="tab-body">
      <TotalsCard
        title="This turn"
        totals={turnTotals}
        highlightCache
      />
      <TotalsCard title="Session running" totals={sessionTotals} />

      <section className="panel-section">
        <h3 className="panel-title">Calls ({all.length})</h3>
        <table className="usage-table">
          <thead>
            <tr>
              <th>#</th>
              <th className="num">prompt</th>
              <th className="num">completion</th>
              <th className="num">cached</th>
              <th className="num">cache write</th>
              <th className="num">cost</th>
              <th className="num" title="running sum(cached)/sum(prompt)">
                run hit
              </th>
              <th className="num" title="running session spend">
                run cost
              </th>
            </tr>
          </thead>
          <tbody>
            {all.map((usage, index) => (
              <CallRow
                key={index}
                usage={usage}
                index={index + 1}
                running={running[index] ?? { rate: 0, cost: 0 }}
              />
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Σ</td>
              <td className="num">{formatNumber(sessionTotals.prompt)}</td>
              <td className="num">{formatNumber(sessionTotals.completion)}</td>
              <td className="num">{formatNumber(sessionTotals.cached)}</td>
              <td className="num">{formatNumber(sessionTotals.cacheWrite)}</td>
              <td className="num">{formatCost(sessionTotals.cost)}</td>
              <td className="num">{formatPercent(totalsCacheHitRate(sessionTotals))}</td>
              <td className="num">{formatCost(sessionTotals.cost)}</td>
            </tr>
          </tfoot>
        </table>
      </section>
    </div>
  );
}

function TotalsCard({
  title,
  totals,
  highlightCache = false,
}: {
  title: string;
  totals: UsageTotals;
  highlightCache?: boolean;
}) {
  const rate = totalsCacheHitRate(totals);
  const hit = totals.cached > 0;

  return (
    <section className={`totals-card${highlightCache ? " totals-emphasis" : ""}`}>
      <div className="totals-head">
        <h3 className="panel-title">{title}</h3>
        {hit && (
          <span className="cache-badge" title="prompt tokens served from cache">
            ⚡ {formatPercent(rate)} cache hit
          </span>
        )}
      </div>
      <div className="stat-grid">
        <Metric label="Prompt" value={formatNumber(totals.prompt)} />
        <Metric label="Completion" value={formatNumber(totals.completion)} />
        <Metric label="Total" value={formatNumber(totals.total)} />
        <Metric label="Cost" value={formatCost(totals.cost)} />
      </div>
      <div className="cache-row">
        <span className="cache-label">cached</span>
        <span className="cache-value cache-hit">
          {formatNumber(totals.cached)}
        </span>
        <span className="cache-label">cache write</span>
        <span className="cache-value cache-write">
          {formatNumber(totals.cacheWrite)}
        </span>
        <span className="cache-label">{totals.calls} calls</span>
      </div>
      {hit && (
        <div className="bar bar-cache">
          <div className="bar-fill" style={{ width: `${rate * 100}%` }} />
        </div>
      )}
    </section>
  );
}

function CallRow({
  usage,
  index,
  running,
}: {
  usage: Usage;
  index: number;
  running: RunningPoint;
}) {
  const cached = cachedTokens(usage);
  const rate = cacheHitRate(usage);
  return (
    <tr className={cached > 0 ? "row-cached" : undefined}>
      <td>{index}</td>
      <td className="num">{formatNumber(usage.prompt_tokens ?? 0)}</td>
      <td className="num">{formatNumber(usage.completion_tokens ?? 0)}</td>
      <td className="num">
        {cached > 0 ? (
          <span className="cache-pill" title={`${formatPercent(rate)} of prompt`}>
            ⚡ {formatNumber(cached)}
          </span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="num">
        {cacheWriteTokens(usage) > 0
          ? formatNumber(cacheWriteTokens(usage))
          : "—"}
      </td>
      <td className="num">{formatCost(usage.cost ?? 0)}</td>
      <td className="num">{formatPercent(running.rate)}</td>
      <td className="num">{formatCost(running.cost)}</td>
    </tr>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
