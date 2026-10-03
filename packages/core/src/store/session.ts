import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentEvent } from "../events.js";
import type { ChatMessage } from "../types.js";

/**
 * Session + event-log persistence (the "L6" layer), backed by node:sqlite
 * (built in since Node 22, no native build step).
 *
 * Two stores, on purpose:
 *  - `events`   : append-only log of every AgentEvent. The raw material for the
 *                 observatory, replay, and diffing across runs.
 *  - `messages` : the current context array, saved as a JSON blob. This is what
 *                 the next turn actually re-sends.
 * Keeping both makes the difference between "what happened" and "what the model
 * currently sees" explicit.
 */

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface StoredEvent {
  seq: number;
  event: AgentEvent;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
      CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  createSession(meta: { id: string; title: string; cwd: string }): SessionMeta {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, cwd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(meta.id, meta.title, meta.cwd, now, now);
    return {
      id: meta.id,
      title: meta.title,
      cwd: meta.cwd,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
  }

  listSessions(): SessionMeta[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.title, s.cwd, s.created_at, s.updated_at,
                (SELECT json_array_length(m.payload) FROM messages m
                  WHERE m.session_id = s.id) AS message_count
         FROM sessions s
         ORDER BY s.updated_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r["id"]),
      title: String(r["title"]),
      cwd: String(r["cwd"]),
      createdAt: Number(r["created_at"]),
      updatedAt: Number(r["updated_at"]),
      messageCount: Number(r["message_count"] ?? 0),
    }));
  }

  getSession(id: string): SessionMeta | undefined {
    const r = this.db
      .prepare(
        `SELECT s.id, s.title, s.cwd, s.created_at, s.updated_at,
                (SELECT json_array_length(m.payload) FROM messages m
                  WHERE m.session_id = s.id) AS message_count
         FROM sessions s WHERE s.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: String(r["id"]),
      title: String(r["title"]),
      cwd: String(r["cwd"]),
      createdAt: Number(r["created_at"]),
      updatedAt: Number(r["updated_at"]),
      messageCount: Number(r["message_count"] ?? 0),
    };
  }

  appendEvents(sessionId: string, events: AgentEvent[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO events (session_id, type, payload, at) VALUES (?, ?, ?, ?)`,
    );
    for (const event of events) {
      stmt.run(sessionId, event.type, JSON.stringify(event), event.at);
    }
  }

  getEvents(sessionId: string, limit = 2000): StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, payload FROM events WHERE session_id = ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(sessionId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seq: Number(r["id"]),
      event: JSON.parse(String(r["payload"])) as AgentEvent,
    }));
  }

  saveMessages(sessionId: string, messages: ChatMessage[]): void {
    this.db
      .prepare(
        `INSERT INTO messages (session_id, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET payload = excluded.payload,
                                              updated_at = excluded.updated_at`,
      )
      .run(sessionId, JSON.stringify(messages), Date.now());
  }

  getMessages(sessionId: string): ChatMessage[] {
    const r = this.db
      .prepare(`SELECT payload FROM messages WHERE session_id = ?`)
      .get(sessionId) as { payload?: string } | undefined;
    if (!r?.payload) return [];
    return JSON.parse(r.payload) as ChatMessage[];
  }

  touch(sessionId: string): void {
    this.db
      .prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`)
      .run(Date.now(), sessionId);
  }

  renameSession(sessionId: string, title: string): void {
    this.db
      .prepare(`UPDATE sessions SET title = ? WHERE id = ?`)
      .run(title, sessionId);
  }
}
