/**
 * M10 — orchestrator: supervisor + registry + durable mailbox, event-stream-native.
 *
 * ## The idea
 *
 * Orca-style multi-agent coordination normally needs an external terminal
 * emulator because it drives **opaque TTY binaries**. This project does not: a
 * worker is just an {@link Agent} (its own session, its own message array), and
 * coordination is a durable mailbox + registry observed through the structured
 * event stream. No PTY, no terminal parsing.
 *
 * ## Frozen public API (the later INT wave consumes these exactly)
 *
 * - {@link WorkerRegistry} — track workers
 *   `{ id, name, task, status, sessionId?, result?, error?, startedAt, endedAt? }`
 *   with methods `add`, `get`, `list`, `update`, `remove`, `snapshot`. Every
 *   status change is appended to `record.transitions`.
 * - {@link Mailbox} — durable, FIFO, per-run queue with delivery + ack + replay.
 *   `send(msg)`, `deliverNext(types?, filter?)`, `ack(id)`,
 *   `pending(types?, filter?)`, `wait(types?, timeoutMs?, filter?)`. A message is
 *   `{ id, from, to, type, subject?, body, at, acked }`. **An unacked delivery is
 *   replayed** on the next delivery — the mechanism behind Orca's `--ack`.
 * - {@link Supervisor} — spawn N workers in parallel via an injected
 *   {@link AgentFactory} (the default builds a fresh {@link Agent} with the
 *   builtin tools plus `ask_coordinator`). Collect outcomes, route coordinator
 *   messages to `onMessage`, expose `waitForAll(timeout)` and `stopAll()`.
 * - {@link createOrchestratorTools} — `ToolDef[]` with `spawn_worker`,
 *   `wait_for`, `send_message`, `list_workers`, `stop_worker`.
 * - Plain types: {@link WorkerStatus}, {@link WorkerRecord},
 *   {@link MailboxMessage}, {@link SupervisorOptions} (plus {@link WorkerSpec},
 *   {@link WorkerReport}, {@link AgentFactory}, {@link WorkerUsageSummary}).
 *
 * ## Wiring (mechanical, for the integrator)
 *
 * ```ts
 * const supervisor = new Supervisor({ client, model, cwd, onMessage: (m) => … });
 * const tools = createOrchestratorTools(supervisor);      // register on the parent Agent
 * // … parent Agent runs; tools spawn/wait/stop workers …
 * await supervisor.waitForAll(120_000);
 * ```
 *
 * The experiment lives in `packages/server/scripts/orchestrator-experiment.ts`;
 * findings in `docs/runs/m10-orchestrator.md`; teaching doc in
 * `docs/mechanisms/orchestrator.md`.
 */

export * from "./types.js";
export { nextId } from "./ids.js";
export * from "./registry.js";
export * from "./mailbox.js";
export * from "./supervisor.js";
export * from "./tools.js";
