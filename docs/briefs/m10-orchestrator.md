# Worker brief — M10 Orchestrator (supervisor, event-stream-native)

Read `docs/briefs/_wave3-constraints.md` and
`packages/core/src/mechanisms/README.md` first; they are binding. Also read
`packages/core/src/mechanisms/subagent/index.ts` (isolated child `Agent`),
`packages/core/src/mechanisms/scheduler/**` (background tasks + settled
outcomes + reinjection), and `docs/STATE.md` §7 (how Orca itself coordinates
workers — the thing we are re-implementing natively).

## Target

- `packages/core/src/mechanisms/orchestrator/**`
- `packages/server/scripts/orchestrator-experiment.ts`
- `docs/runs/m10-orchestrator.md`
- `docs/mechanisms/orchestrator.md`

## The idea (teach this)

Orca-style multi-agent coordination normally needs an external terminal
emulator because it drives **opaque TTY binaries**. This project does not: a
worker is just an `Agent` (its own session, its own message array), and
coordination is a **durable mailbox + registry observed through the structured
event stream**. Implement that core. **Do not** spawn PTYs or parse terminal
output; that belongs in a later, optional adapter.

## Change

1. **`WorkerRegistry`** — track workers: `{ id, name, task, status:
   "starting"|"running"|"blocked"|"done"|"failed", sessionId?, result?, error?,
   startedAt, endedAt? }`. Methods: `add`, `get`, `list`, `update`, `remove`,
   `snapshot()`. Status transitions must be recorded.
2. **`Mailbox`** — a durable, FIFO, per-run message queue with **delivery +
   ack + replay**. A message is `{ id, from, to, type: "question" | "reply" |
   "escalation" | "worker_done" | "note", subject?, body, at, acked }`. API:
   `send(msg)`, `deliverNext(types?)` (oldest unacked matching), `ack(id)`,
   `pending()`, and `wait(types, timeoutMs)` (async). The key teaching behavior:
   an **unacked delivery is replayed** on the next `deliverNext`/`wait` — exactly
   why Orca requires `--ack`. Prove it in the experiment.
3. **`Supervisor`** — spawn N workers **in parallel** from specs, using an
   injected `AgentFactory` (default factory builds a fresh `Agent` with the
   builtin tools, mirroring `mechanisms/subagent`). Collect outcomes, route
   mailbox messages to a coordinator callback, and expose `waitForAll(timeout)`
   and `stopAll()`. A worker that needs a human/coordinator decision sends a
   `question` and becomes `blocked` until a `reply` arrives.
4. **`createOrchestratorTools(supervisor)`** — `ToolDef[]` mirroring Orca's
   vocabulary: `spawn_worker`, `wait_for`, `send_message`, `list_workers`,
   `stop_worker`. A parent `Agent` can call these.

**Interface freeze (the later INT wave consumes these exactly).** Export from
`index.ts`: `WorkerRegistry`, `Mailbox`, `Supervisor`, `createOrchestratorTools`,
and the plain types (`WorkerStatus`, `WorkerRecord`, `MailboxMessage`,
`SupervisorOptions`). Document the API in `index.ts` header comments so wiring
never guesses.

## Experiment (real usage required, bounded)

1. Run 2–3 workers on independent micro-tasks (e.g. "count files matching X",
   "read file Y and answer Z") against the real model.
2. **Cost ledger:** coordinator's main-context `prompt_tokens` when it delegates
   and consumes one-line worker summaries `vs.` doing all three inline; plus
   total tokens and cost across all calls.
3. **Question/ack demo:** a worker sends `question`; the coordinator
   `wait(types="question", …)` blocks until it arrives, `reply`s, and the worker
   resumes. Then show an **unacked delivery replayed**.
4. Show workers are isolated (distinct `sessionId`s; no cross-context leakage).

## Answer in the run doc

- N concurrent isolated workers `vs.` inline: the token/cache difference.
- Why `wait` + `ack` (FIFO replay) is necessary instead of polling.
- Why this needs no PTY/terminal emulator, and where a PTY adapter *would* be
  needed (driving external black-box TTY agents).

## Constraints

As `_wave3-constraints.md`. New files only; no dependency; **no PTY**; do not
edit `events.ts`/`config.ts`/`compose.ts`/web. Keep API usage bounded (≤ ~30
calls); back off on 429.

## Ownership

You own the four paths under Target and nothing else.

## Observable acceptance

- The experiment runs end-to-end against the real model.
- `docs/runs/m10-orchestrator.md` holds the ledger, the question/reply/ack
  transcript, and the replay proof.
- `docs/mechanisms/orchestrator.md` teaches registry + mailbox + supervisor, and
  explains the no-PTY argument.
- `pnpm typecheck` green; commit `M10: orchestrator`.

## Finish protocol

Send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/runs/m10-orchestrator.md`.
Then stop.
