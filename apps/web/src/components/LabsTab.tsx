import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getLabs, runLab } from "../api";
import type { Lab, LabFrame } from "../types";

/**
 * L3 — the Labs tab.
 *
 * Lists the experiment catalog grouped by `kind` (offline first, then the
 * API-costing labs). Running an `api` lab requires an explicit confirm that
 * restates its `apiCalls` budget; a run never starts on load. While running,
 * the output streams into a live console and the exit status/duration lands in
 * the header. Only one lab runs at a time — the server returns 409 otherwise,
 * and this component also disables the other Run buttons while a run is live.
 */

interface ConsoleLine {
  /** `stdout` or `stderr`, so the console can tint error output. */
  stream: "stdout" | "stderr";
  text: string;
}

interface RunState {
  labId: string;
  command?: string;
  lines: ConsoleLine[];
  exit?: Extract<LabFrame, { type: "exit" }>;
  error?: string;
}

export function LabsTab() {
  const [labs, setLabs] = useState<Lab[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const consoleRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await getLabs();
        if (cancelled) return;
        setEnabled(res.enabled);
        setLabs(res.labs);
      } catch (err) {
        if (!cancelled) setLoadError(toMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Kill any in-flight run when the tab unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Autoscroll the console as lines arrive.
  useEffect(() => {
    const node = consoleRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [run?.lines.length]);

  const running = run !== null && run.exit === undefined;

  const handleRun = useCallback((lab: Lab) => {
    if (run && run.exit === undefined) return;

    if (lab.kind === "api") {
      const cost =
        lab.apiCalls !== undefined ? `~${lab.apiCalls} model calls` : "real API calls";
      const ok = window.confirm(
        `${lab.title} hits OpenRouter (${cost}).\n\n` +
          "It runs against the model in your .env and may cost money. Run it now?",
      );
      if (!ok) return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setRun({ labId: lab.id, lines: [] });

    void runLab(lab.id, controller.signal, {
      onFrame: (frame) => {
        setRun((prev) => {
          if (!prev || prev.labId !== lab.id) return prev;
          switch (frame.type) {
            case "start":
              return { ...prev, command: frame.command };
            case "stdout":
              return { ...prev, lines: [...prev.lines, { stream: "stdout", text: frame.line }] };
            case "stderr":
              return { ...prev, lines: [...prev.lines, { stream: "stderr", text: frame.line }] };
            case "exit":
              return { ...prev, exit: frame };
            default:
              return prev;
          }
        });
      },
      onError: (err) => {
        setRun((prev) =>
          prev && prev.labId === lab.id ? { ...prev, error: toMessage(err) } : prev,
        );
      },
    })
      .catch((err) => {
        setRun((prev) =>
          prev && prev.labId === lab.id ? { ...prev, error: toMessage(err) } : prev,
        );
      })
      .finally(() => {
        abortRef.current = null;
      });
  }, [run]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const offline = useMemo(() => labs.filter((l) => l.kind === "offline"), [labs]);
  const api = useMemo(() => labs.filter((l) => l.kind === "api"), [labs]);
  const activeLab = run ? labs.find((l) => l.id === run.labId) : undefined;

  if (loading) {
    return <div className="tab-body labs-empty">Loading labs…</div>;
  }
  if (loadError) {
    return <div className="tab-body labs-empty">Could not load labs: {loadError}</div>;
  }
  if (!enabled) {
    return (
      <div className="tab-body labs-empty">
        Labs are disabled on this server (<code>LABS_ENABLED=false</code>).
      </div>
    );
  }

  return (
    <div className="tab-body labs">
      <p className="labs-intro">
        Each lab runs one experiment harness from{" "}
        <code>packages/server/scripts</code> with its output streaming live.
        <strong> Offline</strong> labs make zero API calls.{" "}
        <strong>API</strong> labs hit OpenRouter and are gated behind a confirm.
      </p>

      <LabGroup
        title="Offline — no API calls"
        labs={offline}
        activeId={run?.labId}
        running={running}
        onRun={handleRun}
      />
      <LabGroup
        title="API — calls OpenRouter"
        labs={api}
        activeId={run?.labId}
        running={running}
        onRun={handleRun}
      />

      {run && activeLab && (
        <div className="lab-console panel-section">
          <div className="lab-console-head">
            <span className="panel-title">Console · {activeLab.title}</span>
            <span className="lab-console-status">
              {running ? (
                <>
                  <span className="lab-dot lab-dot-live" /> running…
                </>
              ) : run.exit ? (
                <ExitBadge exit={run.exit} />
              ) : (
                <span className="lab-badge lab-badge-bad">error</span>
              )}
              {running && (
                <button type="button" className="btn btn-danger btn-sm" onClick={handleStop}>
                  ■ Kill
                </button>
              )}
            </span>
          </div>
          {run.command && <div className="lab-command">{run.command}</div>}
          <pre className="lab-output" ref={consoleRef}>
            {run.lines.length === 0 && !run.exit ? (
              <span className="lab-muted">waiting for output…</span>
            ) : (
              run.lines.map((line, index) => (
                <span
                  key={index}
                  className={line.stream === "stderr" ? "lab-line-err" : "lab-line"}
                >
                  {line.text}
                  {"\n"}
                </span>
              ))
            )}
          </pre>
          {run.error && <div className="lab-run-error">{run.error}</div>}
        </div>
      )}
    </div>
  );
}

function LabGroup({
  title,
  labs,
  activeId,
  running,
  onRun,
}: {
  title: string;
  labs: Lab[];
  activeId?: string;
  running: boolean;
  onRun: (lab: Lab) => void;
}) {
  if (labs.length === 0) return null;
  return (
    <div className="panel-section">
      <span className="panel-title">{title}</span>
      <ul className="lab-list">
        {labs.map((lab) => {
          const isActive = activeId === lab.id;
          return (
            <li key={lab.id} className={`lab-card${isActive ? " lab-card-active" : ""}`}>
              <div className="lab-card-main">
                <div className="lab-card-title">
                  {lab.title}
                  <span className={`lab-badge lab-badge-${lab.kind}`}>{lab.kind}</span>
                  {lab.kind === "api" && lab.apiCalls !== undefined && (
                    <span className="lab-badge lab-badge-cost">≈{lab.apiCalls} calls</span>
                  )}
                </div>
                <div className="lab-card-mech">
                  mechanism: <code>{lab.mechanism}</code>
                  {lab.estSeconds !== undefined && <> · ≈{lab.estSeconds}s</>}
                </div>
                <p className="lab-card-blurb">{lab.blurb}</p>
                <a
                  className="lab-docs-link"
                  href={`https://github.com/agent-things/${lab.docsRun}`}
                  onClick={(e) => e.preventDefault()}
                  title={lab.docsRun}
                >
                  {lab.docsRun}
                </a>
              </div>
              <div className="lab-card-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={running}
                  onClick={() => onRun(lab)}
                >
                  {lab.kind === "api" ? "Run (API) ▶" : "Run ▶"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ExitBadge({ exit }: { exit: Extract<LabFrame, { type: "exit" }> }) {
  if (exit.error) {
    return <span className="lab-badge lab-badge-bad">spawn error</span>;
  }
  if (exit.timedOut) {
    return <span className="lab-badge lab-badge-bad">timeout</span>;
  }
  const ok = exit.code === 0;
  return (
    <span className={`lab-badge ${ok ? "lab-badge-ok" : "lab-badge-bad"}`}>
      exit {exit.code ?? "?"} · {(exit.durationMs / 1000).toFixed(1)}s
    </span>
  );
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
