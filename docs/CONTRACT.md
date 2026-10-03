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
| POST | `/api/sessions/:id/compact` | — | `{ before, after, summarized, keptRecent, keptLeading, placement }` |
| POST | `/api/sessions/:id/messages` | `{ input: string }` | `text/event-stream` |

`SessionMeta = { id, title, cwd, createdAt, updatedAt, messageCount }`.

`POST /api/sessions/:id/compact` (M3, additive) forces one compaction of the
live agent's history now. `before`/`after` are coarse token estimates, and it
returns `409 { error }` when compaction is not configured
(`COMPACT_THRESHOLD_TOKENS` unset/`0`). A `mechanism` event
(`name:"compaction"`, `phase:"compacted"`, `data.via:"api"`) is appended to the
session log and the live messages are persisted.

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

**M6 hooks/permissions events (additive).** When the loop runs a lifecycle hook
it emits one `mechanism` event with `name:"hooks"` and `phase` equal to the hook
point (`userPromptSubmit`, `preToolUse`, `postToolUse`, `preCompact`); `data`
carries `{ records }` (the `HookOutcomeRecord[]` audit list), plus `mutated` and
the effective `input` for `preToolUse`. The **tool verdict** still rides the
existing `permission.decision` event, whose `decision` may now be `"ask"`:

```jsonc
{ "type": "permission.decision", "toolCallId": "call_1", "name": "write_file",
  "decision": "ask", "reason": "writes mutate the workspace", "at": 1791032649972 }
```

Execution rule (unchanged when unconfigured): `deny` blocks; `ask` proceeds
**only** when `PERMISSION_MODE=yolo`, otherwise it is blocked with a
"pending approval (non-interactive)" tool result; `allow` proceeds. The event
always records the *true* verdict, independent of whether the call proceeds.

**M3 compaction event (additive).** When auto-compaction fires at the top of a
step it emits `{ name:"compaction", phase:"compacted", data:{ before, after,
summarized, keptRecent, keptLeading, placement } }` (plus a `hooks`/`preCompact`
event when hooks are configured). The `preToolUse`/`postToolUse` events follow
`tool.call`/`tool.result` respectively.

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
- `HOOKS_FILE` (path to a hooks JSON file — see
  `packages/core/src/mechanisms/hooks/fixtures/hooks.json`; unset = no hooks).
- `POLICY_FILE` (path to an ordered rules JSON file — see
  `.../fixtures/rules.json`; unset = no rule policy). When either is set, the
  server builds a `gate` that calls `decide(policy, hooks, req)` for every tool
  call; when both are unset the loop uses the coarse `PERMISSION_MODE` gate and
  behavior is exactly as before.
- `COMPACT_THRESHOLD_TOKENS` (estimated-token threshold for auto-compaction;
  `0`/unset = **off**). When `> 0`, the loop compacts at the top of a step
  whenever the live history estimate exceeds it.
- `COMPACT_KEEP_RECENT` (messages kept verbatim at the tail; default `8`).
- `COMPACT_KEEP_LEADING` (messages kept verbatim before the summarized span;
  default `1`).
- `COMPACT_PLACEMENT` (`spliced` | `leading`; default `spliced`).

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
