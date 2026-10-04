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
| GET | `/api/mechanisms` | — | `{ skills: string[], mcpServers: string[], tools: string[], memory: { enabled, dir?, count?, systemInject? }, orchestrator: { enabled, workers }, toolSearch: { enabled } }` |
| GET | `/api/memories` | — | `{ enabled:true, dir, count, systemInject, entries }` or `{ enabled:false }` (M9) |
| GET | `/api/workers` | — | `{ enabled:true, coordinatorId, workers, reports, usage, pending }` or `{ enabled:false }` (M10) |
| GET | `/api/sessions` | — | `SessionMeta[]` |
| POST | `/api/sessions` | `{ title?: string }` | `SessionMeta` |
| POST | `/api/sessions/:id/fork` | `{ atMessageIndex?, title? }` | `SessionMeta` |
| GET | `/api/sessions/:id` | — | `{ session: SessionMeta, messages: ChatMessage[] }` |
| GET | `/api/sessions/:id/events` | — | `{ seq: number, event: AgentEvent }[]` |
| POST | `/api/sessions/:id/compact` | — | `{ before, after, summarized, keptRecent, keptLeading, placement }` |
| GET | `/api/sessions/:id/checkpoints` | — | `{ turns: [{ turnId, files: [{ path, existed, size, hash }] }] }` |
| POST | `/api/sessions/:id/checkpoints/:turnId/restore` | — | `RestoreReport` |
| POST | `/api/sessions/:id/schedule` | `{ afterMs?, at?, intervalMs?, prompt }` | `TaskRecord` |
| GET | `/api/sessions/:id/tasks` | — | `TaskRecord[]` |
| POST | `/api/sessions/:id/messages` | `{ input: string }` | `text/event-stream` |
| POST | `/api/sessions/:id/approvals` | `{ toolCallId, decision: "allow"\|"deny", reason? }` | `{ ok: true, toolCallId, decision }` (M12) |
| GET | `/api/labs` | — | `{ enabled: boolean, labs: Lab[] }` (L3) |
| POST | `/api/labs/:id/run` | — | `text/event-stream` of `LabFrame` (L3) |

`SessionMeta = { id, title, cwd, createdAt, updatedAt, messageCount }`.

**M8 fork (additive).** `POST /api/sessions/:id/fork` branches a session: the new
session's messages are the source's `slice(0, atMessageIndex ?? end)` (a copy, not
a view), the event log starts empty, and the title defaults to
`${source.title} (fork)` (override with `title`). Returns the new `SessionMeta`,
or `404 { error }` when the source is unknown; `atMessageIndex` must be a
non-negative integer. The source session is left untouched.

`POST /api/sessions/:id/compact` (M3, additive) forces one compaction of the
live agent's history now. `before`/`after` are coarse token estimates, and it
returns `409 { error }` when compaction is not configured
(`COMPACT_THRESHOLD_TOKENS` unset/`0`). A `mechanism` event
(`name:"compaction"`, `phase:"compacted"`, `data.via:"api"`) is appended to the
session log and the live messages are persisted.

**M6 checkpoints (additive).** Before the agent executes `write_file` or
`edit_file`, the composition root snapshots the target file's current bytes into
the loop turn (`ToolContext.turnId`). `GET /api/sessions/:id/checkpoints` lists
those turns (session-scoped; `hash` is the sha256 of the snapshot bytes, `""`
when the file did not exist). `POST
/api/sessions/:id/checkpoints/:turnId/restore` restores every file in that turn
byte-for-byte and returns a `RestoreReport`:

```jsonc
{ "turnId": "…-t1", "identical": true, "restored": 1, "deleted": 0,
  "entries": [{ "path": "…", "action": "restore",
                "beforeHash": "…", "afterHash": "…", "identical": true }] }
```

`identical` is true iff every restored/absent file's on-disk sha256 equals the
snapshot. Restoring an unknown turn returns `404 { error }`. Snapshotting only
happens for those two write tools, so a read-only boot is byte-for-byte
unchanged.

**M7 scheduler (additive).** `POST /api/sessions/:id/schedule` registers a task;
exactly one timing field is required: `afterMs` (number ≥ 0), `at` (epoch ms or
ISO date) or `intervalMs` (number > 0), plus a non-empty `prompt`. The task runs
a **fresh nested `Agent`**, seeded from the session's persisted messages, and
the returned `TaskRecord` carries the generated id. Tasks are named with the
session id, so `GET /api/sessions/:id/tasks` lists that session's tasks. When a
task settles the server appends the outcome as a `role:"user"` message to the
session (via `reinjectTaskOutcome`), persists the messages, and appends a
`task.settled` event. Returns `409 { error }` when `SCHEDULER_ENABLED=false`.
`TaskRecord = { id, name, kind, state, runs, lastStatus?, result?, error?,
createdAt, nextRunAt?, intervalMs?, … }`.

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

**M8 file diff (additive).** The composition root wraps `write_file`/`edit_file`:
it reads the target (relative to `ctx.cwd`; missing = `""`) **before** and
**after** the call and, when the bytes changed, appends one `mechanism` event to
that tool's `ToolResult.events`:

```jsonc
{ "type": "mechanism", "name": "diff", "phase": "file",
  "data": { "path": "src/a.ts", "added": 2, "removed": 1, "patch": "@@ -1,3 +1,4 @@…" },
  "at": 1791032649972 }
```

`patch` is a hunks-only unified diff from the pure `unifiedDiff()` in
`@agent/core` (no new dependency). It is observability only and never enters the
model's context; nothing is emitted when the file is unchanged (or on a failed
call). The web renders these in a **Diff** tab that appears once at least one
diff exists.

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
M12 adds an interactive path for `ask` (below); with no approval seam wired the
rule above holds byte-for-byte.

**M3 compaction event (additive).** When auto-compaction fires at the top of a
step it emits `{ name:"compaction", phase:"compacted", data:{ before, after,
summarized, keptRecent, keptLeading, placement } }` (plus a `hooks`/`preCompact`
event when hooks are configured). The `preToolUse`/`postToolUse` events follow
`tool.call`/`tool.result` respectively.

**M7 `task.settled` event (additive).** When a scheduled task settles, the server
persists one event (it is not part of the `/messages` SSE turn; it appears in the
event log and the web Timeline):

```jsonc
{ "type": "task.settled", "taskId": "sched-…-1", "name": "<sessionId>",
  "kind": "one-shot" | "interval", "status": "succeeded" | "failed" | "cancelled",
  "result": "READY", "error": "…", "run": 1, "at": 1791034410138 }
```

`result`/`error` are optional (present on success/failure respectively). The same
settlement also appends a re-injected `role:"user"` message to the session (see
`reinjectTaskOutcome`), which is how the model next sees the outcome.

**M9 memory (additive).** With `MEMORY_ENABLED=true` the composition root opens
a `MemoryStore` at `MEMORY_DIR` and registers exactly one `memory` tool
(`save`/`list`/`search`/`forget`). Its output is a **tool result at the tail** of
the message array, so recalling a memory never rewrites the system prefix (the
M9 cache measurement). `GET /api/memories` returns the live read-out
`{ enabled:true, dir, count, systemInject, entries }`; `entries` is a copy of the
store's live entries, so a `save` during a turn is visible immediately. When
`MEMORY_ENABLED` is unset the route returns `{ enabled:false }` and no `memory`
tool is registered (behaviour unchanged). `MEMORY_SYSTEM_INJECT=true` (only
meaningful with memory enabled) additionally appends
`memorySystemSuffix(store.all())` to the **end** of the assembled system prompt
via `systemPromptOverride`; the block is frozen at boot, and appending at the
tail is the append-only-safe position (M2 §c′ / M9 §4).

**M10 orchestrator (additive).** With `ORCHESTRATOR_ENABLED=true` the
composition root creates a `Supervisor` and registers its five coordinator tools
(`spawn_worker`, `wait_for`, `send_message`, `list_workers`, `stop_worker`).
`ORCHESTRATOR_MAX_WORKERS` (default `4`) caps how many workers may be active at
once; the host wraps `spawn_worker` and returns a tool error past the cap.
`GET /api/workers` returns `{ enabled:true, coordinatorId, workers, reports,
usage, pending }` where `workers` is the registry's status-transition log,
`reports`/`usage` are the per-worker token ledger, and `pending` is the unacked
mailbox tail. When unset the route returns `{ enabled:false }` and no
orchestrator tools are registered. Worker messages are consumed in-turn by
`wait_for`; anything not consumed is observable through `GET /api/workers` (the
supervisor is not bound to one session, so this wave does not re-inject into a
session log).

**M11 lazy tool exposure (additive).** With `TOOL_SEARCH_ENABLED=true` the
composition root wraps the **fully built** final `ToolRegistry` with
`createToolSearchRegistry(realRegistry)`, so the parent `Agent` sees only
`tool_call` and `tool_search` while every real tool (builtins, `use_skill`,
MCP, `task`, `memory`, orchestrator) stays callable through the facade.
`GET /api/config` therefore lists exactly those two names. Caveat: the facade's
own `readOnly:false` drives the permission layer, so a per-tool gate should
resolve the inner tool rather than gate the facade (mechanism doc). When unset
the real registry is exposed unchanged.

**M12 interactive approval (additive).** When the composition root supplies
`AgentConfig.approvals` and a gate returns `ask`, the loop pauses on the async
callback instead of applying the non-interactive rule. It emits two new events
around the pause:

```jsonc
{ "type": "approval.requested", "toolCallId": "call_1", "name": "write_file",
  "input": { "path": "a.txt", "content": "…" }, "turnId": "s-t1",
  "reason": "writes mutate the workspace", "at": 1791096373414 }
{ "type": "approval.resolved", "toolCallId": "call_1", "decision": "allow",
  "reason": "…", "at": 1791096373677 }
```

`approval.resolved.decision === "deny"` pushes a `Denied: …` tool message;
`"allow"` proceeds to execute the tool (then `tool.result`). Neither event is
emitted when `approvals` is absent. The server keys pending requests by
`sessionId:toolCallId` and exposes `POST /api/sessions/:id/approvals`
(`404` unknown session, `409` no waiting turn, `400` bad body); it resolves
`deny` after `APPROVAL_TIMEOUT_MS` (default 30s) so a turn can never hang.
`reason` is accepted for host audit/display.

**M12 slash commands (additive).** `POST /api/sessions/:id/messages` inspects
`input` for a leading `/<name>` **before** running a model turn. A **registered**
command (`/help`, `/memory <query>`, `/workers`, `/compact`) is handled
server-side and emits `mechanism` (`name:"command"`, `phase:<name>`,
`data:{ args, reply, injected }`) plus a synthetic `assistant.message` and
`turn.end` — **no model turn** for a synthetic reply. A command may instead
return `inject: ChatMessage[]`, which is appended at the **tail** (never
splicing the system prefix) before a normal model turn. **Unknown** slash input
(`/foo`, `/etc/hosts`) is not a command and falls through as ordinary model
input. Commands are not exposed as tools, so they add no schema tokens.

**L3 Labs (additive).** `GET /api/labs` returns the experiment catalog; the
server's `registry.ts` is the **allowlist**, and a run target is always resolved
from it by id — the server never accepts a caller-supplied path.

```jsonc
{ "enabled": true, "labs": [
  { "id": "forensics", "title": "Cache forensics classifier",
    "mechanism": "forensics", "kind": "offline", "apiCalls": 5, "estSeconds": 30,
    "script": "forensics-experiment.ts", "docsRun": "docs/runs/l1-cache-forensics.md",
    "blurb": "…" } ] }
```

`kind` is `"offline"` (zero API calls) or `"api"` (talks to OpenRouter; `apiCalls`
is the harness's stated budget). `POST /api/labs/:id/run` spawns the allowlisted
script from the repo root, inheriting `process.env` (so the repo-root `.env`
reaches API labs), and streams `text/event-stream` frames:

```
event: start   data: { type:"start", id, command }
event: stdout  data: { type:"stdout", line }
event: stderr  data: { type:"stderr", line }
event: exit    data: { type:"exit", code, durationMs, timedOut?, error? }
```

`exit` is terminal. Guards: `404` for an unknown id, `403` when
`LABS_ENABLED=false`, and `409 { error:"busy" }` when another lab is already
running (at most one at a time). `LAB_TIMEOUT_MS` (default `300000`) kills the
process **tree** and emits `exit` with `timedOut:true`; a client disconnect
aborts the run and kills the tree; the child is never spawned on page load, only
on an explicit run.

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
- `CHECKPOINT_DIR` (directory for M6 checkpoint snapshots, mirrored to
  `checkpoints.json`; default `${DATA_DIR}/checkpoints`). Always opened;
  snapshotting only occurs for `write_file`/`edit_file`.
- `SCHEDULER_ENABLED` (`true` | `false`, default `true`). When `false`,
  `POST …/schedule` returns `409` and `GET …/tasks` is empty.
- `MEMORY_ENABLED` (`true` | `false`, default `false`). When `true`, opens the
  M9 `MemoryStore` at `MEMORY_DIR` and registers the `memory` tool; exposes
  `GET /api/memories`.
- `MEMORY_DIR` (directory for the M9 NDJSON log; default `${DATA_DIR}/memory`).
- `MEMORY_SYSTEM_INJECT` (`true` | `false`, default `false`). When `true` (and
  memory is enabled), appends the memory block to the **end** of the system
  prompt via `systemPromptOverride` (frozen at boot; see M9 note above).
- `ORCHESTRATOR_ENABLED` (`true` | `false`, default `false`). When `true`,
  creates the M10 `Supervisor` and registers the five coordinator tools;
  exposes `GET /api/workers`.
- `ORCHESTRATOR_MAX_WORKERS` (positive integer, default `4`): cap on concurrent
  active workers; `spawn_worker` errors past the cap.
- `TOOL_SEARCH_ENABLED` (`true` | `false`, default `false`). When `true`, wraps
  the final registry in the M11 two-tool facade, so `GET /api/config` lists only
  `tool_call` + `tool_search`.
- `APPROVAL_TIMEOUT_MS` (positive integer, default `30000`). How long an `ask`
  approval may wait before the server resolves it `deny` (fail closed). Only
  meaningful when a gate (`POLICY_FILE`/`HOOKS_FILE`) can produce `ask`.
- `LABS_ENABLED` (`true` | `false`, default `true`). When `true`, `GET /api/labs`
  returns the experiment catalog and `POST /api/labs/:id/run` streams a run. When
  `false`, the catalog reports `{ enabled:false, labs:[] }`, every run returns
  `403`, and the rest of the server behaves exactly as before.
- `LAB_TIMEOUT_MS` (positive integer, default `300000`). Wall-clock ceiling per
  lab run; on expiry the process **tree** is killed and the run emits an `exit`
  frame with `timedOut:true`.

## Web app (Vite + React + TS, dev port 5173)

- Proxy `/api` -> `http://localhost:8787`.
- Two panes. Left: conversation (user/assistant/tool messages). Right: the
  **context observatory**, driven entirely by the event stream:
  - **Context** tab: from `context.compiled` — the full message list actually
    sent, plus the `breakdown` (system chars, message count, tool count,
    estimated tokens, sections).
  - **Request** tab: from `request.sent` — the raw JSON request body, collapsible.
  - **Usage** tab: from `usage` — prompt/completion/total tokens, `cached_tokens`,
    `cache_write_tokens`, cost; accumulate per turn. The session headline shows
    total prompt / completion / cached tokens, hit rate, and total cost (M8).
  - **Timeline** tab: every event in order, terminal-style.
  - **Diff** tab (M8, additive): every `mechanism` `name:"diff"` patch, rendered
    monospace with `+` green / `-` red / context dim. Only shown once a diff
    exists.
- Send box posts to `/api/sessions/:id/messages` and consumes the SSE stream,
  appending events live. The box also accepts slash commands (`/help`,
  `/memory <query>`, `/workers`, `/compact`); their synthetic replies arrive on
  the same stream and render like an assistant message.
- **Approval control (M12, additive):** on an `approval.requested` frame the
  app shows an Allow/Deny bar (tool, reason, input) and POSTs the decision to
  `/api/sessions/:id/approvals`; `approval.resolved` clears it.
- Session picker: list sessions, create a new one, load existing events on select.
  A **Fork** action (M8) branches the selected session; each assistant turn also
  exposes a per-message fork through that point.
- **Labs tab (L3, additive):** lists the `GET /api/labs` catalog grouped by
  `kind` (offline first), each with title, blurb, mechanism, `apiCalls`, a link
  to its `docsRun`, and a **Run** button. An `api` lab runs only after an
  explicit confirm that restates its call budget. A run renders a live
  stdout/stderr console plus the exit status/duration. Nothing runs on load.

No component library. Hand-written CSS is fine and preferred.
