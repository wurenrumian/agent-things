import type { AgentEvent } from "../types";

/**
 * M8: the file-diff view. It collects `mechanism` events emitted by the write
 * tools (`name === "diff"`, `phase === "file"`) and renders each unified patch.
 * Nothing here is part of the model's context — it is pure observability.
 */

interface DiffEventData {
  path?: unknown;
  added?: unknown;
  removed?: unknown;
  patch?: unknown;
}

export interface DiffEntry {
  path: string;
  added: number;
  removed: number;
  patch: string;
  at: number;
}

/** Every `diff` mechanism event in arrival order. */
export function collectDiffs(events: AgentEvent[]): DiffEntry[] {
  const diffs: DiffEntry[] = [];
  for (const event of events) {
    if (event.type !== "mechanism" || event.name !== "diff") continue;
    const data = (event.data ?? {}) as DiffEventData;
    diffs.push({
      path: typeof data.path === "string" ? data.path : "(unknown)",
      added: typeof data.added === "number" ? data.added : 0,
      removed: typeof data.removed === "number" ? data.removed : 0,
      patch: typeof data.patch === "string" ? data.patch : "",
      at: event.at,
    });
  }
  return diffs;
}

export function DiffTab({ events }: { events: AgentEvent[] }) {
  const diffs = collectDiffs(events);

  if (diffs.length === 0) {
    return (
      <p className="empty-note">
        No file changes yet. Run a turn that writes or edits a file and the
        unified patch shows up here.
      </p>
    );
  }

  return (
    <div className="tab-body">
      {diffs.map((diff, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <section className="diff-card" key={index}>
          <div className="diff-head">
            <span className="diff-path" title={diff.path}>
              {diff.path}
            </span>
            <span className="diff-stats">
              <span className="diff-added">+{diff.added}</span>
              <span className="diff-removed">−{diff.removed}</span>
            </span>
          </div>
          <pre className="diff-body">
            {diff.patch.split("\n").map((line, lineIndex) => (
              <span
                // eslint-disable-next-line react/no-array-index-key
                key={lineIndex}
                className={`diff-line ${diffLineClass(line)}`}
              >
                {line === "" ? " " : line}
                {"\n"}
              </span>
            ))}
          </pre>
        </section>
      ))}
    </div>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return "diff-ctx";
}
