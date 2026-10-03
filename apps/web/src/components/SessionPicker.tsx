import { formatDateTime } from "../format";
import type { SessionMeta } from "../types";

interface SessionPickerProps {
  sessions: SessionMeta[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRefresh: () => void;
}

export function SessionPicker({
  sessions,
  selectedId,
  loading,
  onSelect,
  onNew,
  onRefresh,
}: SessionPickerProps) {
  return (
    <aside className="session-picker">
      <div className="picker-head">
        <span className="picker-title">Sessions</span>
        <div className="picker-actions">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onRefresh}
            disabled={loading}
            title="Refresh session list"
          >
            ↻
          </button>
          <button type="button" className="btn btn-primary" onClick={onNew}>
            + New
          </button>
        </div>
      </div>
      <ul className="session-list">
        {sessions.length === 0 && (
          <li className="empty-note">No sessions yet.</li>
        )}
        {sessions.map((session) => (
          <li key={session.id}>
            <button
              type="button"
              className={`session-item${
                session.id === selectedId ? " session-active" : ""
              }`}
              onClick={() => onSelect(session.id)}
            >
              <span className="session-name">{session.title}</span>
              <span className="session-sub">
                {session.messageCount} msgs · {formatDateTime(session.updatedAt)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
