# M0 Contract (frozen)

Everything below is frozen for M0. Implement against this, do not change it
unilaterally. Source of truth for types:

- `packages/core/src/types.ts` — message / request / usage shapes
- `packages/core/src/events.ts` — the `AgentEvent` vocabulary
- `packages/core/src/index.ts` — the public exports of `@agent/core`

`tools` in `GET /api/config` and `/api/mechanisms` is the **live** registry: the
five builtin tools, plus any mechanism tools the composition root wired up
(`use_skill`, `task`, MCP tools). Names are always sorted (prompt-cache stable).

Package names: `@agent/core`, `@agent/server`, `@agent/web`.

## HTTP API (server, default http://localhost:8787)

All responses JSON unless noted. Errors: `{ "error": string }` with status.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok: true, model: string }` |
| GET | `/api/config` | — | `{ model, cwd, permissionMode, tools: string[] }` |
| GET | `/api/mechanisms` | — | `{ skills: string[], mcpServers: string[], tools: string[] }` |
| GET | `/api/sessions` | — | `SessionMeta[]` |
| POST | `/api/sessions` | `{ title?: string }` | `SessionMeta` |
| GET | `/api/sessions/:id` | — | `{ session: SessionMeta, messages: ChatMessage[] }` |
| GET | `/api/sessions/:id/events` | — | `{ seq: number, event: AgentEvent }[]` |
| POST | `/api/sessions/:id/messages` | `{ input: string }` | `text/event-stream` |

`SessionMeta = { id, title, cwd, createdAt, updatedAt, messageCount }`.

### SSE stream for `POST /messages`

Each agent event is one SSE frame:

```
event: <AgentEvent.type>
data: <JSON of the full AgentEvent>
```

The stream ends after a `turn.end` event. CORS must allow the web dev origin.

**`mechanism` event (additive).** Mechanism tools surface progress through an
optional `ToolResult.events` array; the loop yields those events, in order,
immediately after `tool.result`. They are persisted and streamed like any other
event, but never enter the model's context. Shape:

```jsonc
{ "type": "mechanism", "name": "skills", "phase": "loaded",
  "data": { "skill": "code-review" }, "at": 1791032649972 }
```

`name` identifies the mechanism (`skills`, `subagent`, `mcp:<server>`); `phase`
is mechanism-defined (`loaded`, `completed`, `called`, `error`, …); `data` is
optional, mechanism-specific detail. The web Timeline renders them.

## Config (server, from env)

Read from repo-root `.env` (do not add a dotenv dependency; write a tiny loader).

- `OPENROUTER_API_KEY` (required; fail fast with a clear message if missing)
- `OPENROUTER_MODEL` (default `anthropic/claude-sonnet-4.5`)
- `OPENROUTER_REFERER`, `OPENROUTER_TITLE` (optional)
- `PORT` (default `8787`)
- `DATA_DIR` (default `./data`, relative to repo root) — sqlite file `agent.db`
- `PERMISSION_MODE` (`yolo` | `standard` | `readonly`, default `yolo`)
- `AGENT_CWD` (the directory the agent operates on; default repo root)
- `SKILLS_DIR` (directory scanned for skill subdirectories; default `./skills`).
  When it contains no skills, `use_skill` is not registered and behavior is
  unchanged.
- `MCP_SERVERS` (JSON array of `{ name, command, args, env? }`, default `[]`).
  Each server is connected over stdio at startup; one that fails to connect is
  logged and skipped, never fatal.
- `SUBAGENT_MAX_STEPS` (step ceiling for each nested subagent; default `12`)

## Web app (Vite + React + TS, dev port 5173)

- Proxy `/api` -> `http://localhost:8787`.
- Two panes. Left: conversation (user/assistant/tool messages). Right: the
  **context observatory**, driven entirely by the event stream:
  - **Context** tab: from `context.compiled` — the full message list actually
    sent, plus the `breakdown` (system chars, message count, tool count,
    estimated tokens, sections).
  - **Request** tab: from `request.sent` — the raw JSON request body, collapsible.
  - **Usage** tab: from `usage` — prompt/completion/total tokens, `cached_tokens`,
    `cache_write_tokens`, cost; accumulate per turn.
  - **Timeline** tab: every event in order, terminal-style.
- Send box posts to `/api/sessions/:id/messages` and consumes the SSE stream,
  appending events live.
- Session picker: list sessions, create a new one, load existing events on select.

No component library. Hand-written CSS is fine and preferred.
