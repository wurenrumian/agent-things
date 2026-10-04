import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  Agent,
  Store,
  type AgentConfig,
  type SessionMeta,
} from "@agent/core";
import { loadConfig, type ServerConfig } from "./config.js";
import { composeAgent, type ComposedAgent } from "./compose.js";
import type { CheckpointStore } from "../../core/src/mechanisms/checkpoint/index.js";
import type { Supervisor } from "../../core/src/mechanisms/orchestrator/index.js";
import {
  reinjectTaskOutcome,
  taskOutcomeToEvent,
  type Scheduler,
} from "../../core/src/mechanisms/scheduler/index.js";

/**
 * HTTP + SSE shell around the `@agent/core` kernel (the "L8" layer).
 *
 * The server owns no agent logic: it maps the frozen HTTP contract
 * (`docs/CONTRACT.md`) onto `Agent.run()`, persists every `AgentEvent` through
 * `Store`, and streams the same events to the browser as SSE. The kernel stays
 * transport-agnostic; a TUI could be added later without touching it.
 */

const WEB_ORIGIN = "http://localhost:5173";

interface Runtime {
  config: ServerConfig;
  store: Store;
  agents: Map<string, Agent>;
  agentConfig: AgentConfig;
  /** M6 per-turn file snapshots. */
  checkpoints: CheckpointStore;
  /** M7 background/scheduled tasks (absent when `SCHEDULER_ENABLED=false`). */
  scheduler?: Scheduler;
  /** M9 memory read-out (absent when `MEMORY_ENABLED=false`). */
  memories?: ComposedAgent["memories"];
  /** M10 orchestrator supervisor (absent when `ORCHESTRATOR_ENABLED=false`). */
  supervisor?: Supervisor;
  /** Mechanism inventory for `GET /api/mechanisms`. */
  skills: string[];
  mcpServers: string[];
  /** Whether the M11 lazy tool facade is active (`TOOL_SEARCH_ENABLED`). */
  toolSearchEnabled: boolean;
  /** Tear down long-lived mechanism resources (MCP stdio children). */
  close: () => void;
}

async function createRuntime(config: ServerConfig): Promise<Runtime> {
  const composed = await composeAgent(config);
  const store = new Store(config.dbFile);
  const agents = new Map<string, Agent>();

  const rt: Runtime = {
    config,
    store,
    agents,
    agentConfig: composed.agentConfig,
    checkpoints: composed.checkpoints,
    scheduler: composed.scheduler,
    memories: composed.memories,
    supervisor: composed.supervisor,
    skills: composed.skills,
    mcpServers: composed.mcpServers,
    toolSearchEnabled: config.toolSearchEnabled,
    close: composed.close,
  };

  /**
   * M7 settlement handler: a scheduled task finished outside any turn. Re-inject
   * its outcome into the session's message array (so the next model turn sees
   * it) and append a `task.settled` event. Task names are session ids, so the
   * outcome tells us which session to update.
   */
  composed.scheduler?.subscribe((outcome) => {
    const sessionId = outcome.name;
    if (!store.getSession(sessionId)) return;

    // Prefer the live cached agent's array so a concurrent save cannot drop the
    // message; fall back to the persisted copy for a cold session.
    const live = agents.get(sessionId);
    const messages = live ? live.messages : store.getMessages(sessionId);
    reinjectTaskOutcome(messages, outcome);
    store.saveMessages(sessionId, messages);
    store.touch(sessionId);

    const proposed = taskOutcomeToEvent(outcome, Date.now());
    store.appendEvents(sessionId, [
      {
        ...proposed,
        kind: proposed.kind === "interval" ? "interval" : "one-shot",
      },
    ]);
  });

  return rt;
}

/** One `Agent` per session, created on first use with messages from the store. */
function getAgent(rt: Runtime, session: SessionMeta): Agent {
  const existing = rt.agents.get(session.id);
  if (existing) return existing;
  const agent = new Agent(
    { ...rt.agentConfig, cwd: session.cwd },
    session.id,
    rt.store.getMessages(session.id),
  );
  rt.agents.set(session.id, agent);
  return agent;
}

/** Parse a JSON body, returning `undefined` for missing / malformed input. */
async function readJson(
  c: Context,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await c.req.json();
    if (typeof value === "object" && value !== null) {
      return value as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function buildApp(rt: Runtime): Hono {
  const app = new Hono();

  app.use("*", cors({ origin: WEB_ORIGIN }));

  app.get("/api/health", (c) => c.json({ ok: true, model: rt.config.model }));

  app.get("/api/config", (c) =>
    c.json({
      model: rt.config.model,
      cwd: rt.config.cwd,
      permissionMode: rt.config.permissionMode,
      tools: rt.agentConfig.tools.list().map((t) => t.name),
    }),
  );

  app.get("/api/mechanisms", (c) =>
    c.json({
      skills: rt.skills,
      mcpServers: rt.mcpServers,
      tools: rt.agentConfig.tools.list().map((t) => t.name),
      memory: rt.memories
        ? {
            enabled: true,
            dir: rt.memories.dir,
            count: rt.memories.count,
            systemInject: rt.memories.systemInject,
          }
        : { enabled: false },
      orchestrator: {
        enabled: rt.supervisor !== undefined,
        workers: rt.supervisor?.registry.size() ?? 0,
      },
      toolSearch: { enabled: rt.toolSearchEnabled },
    }),
  );

  /**
   * M9: the live memory read-out. `{ enabled:false }` when `MEMORY_ENABLED` is
   * unset, so the endpoint is inert by default. `entries` is a live copy taken
   * from the store, so an entry saved by the `memory` tool during a turn shows
   * up immediately.
   */
  app.get("/api/memories", (c) => {
    if (!rt.memories) return c.json({ enabled: false });
    return c.json({
      enabled: true,
      dir: rt.memories.dir,
      count: rt.memories.count,
      systemInject: rt.memories.systemInject,
      entries: rt.memories.entries,
    });
  });

  /**
   * M10: the orchestrator supervisor snapshot. `{ enabled:false }` when
   * `ORCHESTRATOR_ENABLED` is unset. `workers` is the registry's transition
   * log; `pending` are unacked mailbox messages not consumed by `wait_for`.
   */
  app.get("/api/workers", (c) => {
    const supervisor = rt.supervisor;
    if (!supervisor) return c.json({ enabled: false });
    return c.json({
      enabled: true,
      coordinatorId: supervisor.coordinatorId,
      workers: supervisor.registry.snapshot(),
      reports: supervisor.reports(),
      usage: supervisor.usage(),
      pending: supervisor.mailbox.pending(),
    });
  });

  app.get("/api/sessions", (c) => c.json(rt.store.listSessions()));

  app.post("/api/sessions", async (c) => {
    const body = await readJson(c);
    const rawTitle = body?.["title"];
    const title =
      typeof rawTitle === "string" && rawTitle.trim().length > 0
        ? rawTitle.trim()
        : "New session";
    const session = rt.store.createSession({
      id: crypto.randomUUID(),
      title,
      cwd: rt.config.cwd,
    });
    return c.json(session);
  });

  /**
   * M8: fork a session. Body `{ atMessageIndex?, title? }`; returns the new
   * `SessionMeta` (404 when the source is unknown). The copied prefix is the
   * source's first `atMessageIndex` messages (default: all).
   */
  app.post("/api/sessions/:id/fork", async (c) => {
    const id = c.req.param("id");
    if (!rt.store.getSession(id)) {
      return c.json({ error: "session not found" }, 404);
    }

    const body = await readJson(c);
    const rawIndex = body?.["atMessageIndex"];
    let atMessageIndex: number | undefined;
    if (rawIndex !== undefined && rawIndex !== null) {
      if (
        typeof rawIndex !== "number" ||
        !Number.isInteger(rawIndex) ||
        rawIndex < 0
      ) {
        return c.json(
          { error: "atMessageIndex must be a non-negative integer" },
          400,
        );
      }
      atMessageIndex = rawIndex;
    }

    const rawTitle = body?.["title"];
    const title =
      typeof rawTitle === "string" && rawTitle.trim().length > 0
        ? rawTitle.trim()
        : undefined;

    const forked = rt.store.forkSession(id, { atMessageIndex, title });
    return c.json(forked);
  });

  app.get("/api/sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = rt.store.getSession(id);
    if (!session) return c.json({ error: "session not found" }, 404);
    const messages = rt.agents.get(id)?.messages ?? rt.store.getMessages(id);
    return c.json({ session, messages });
  });

  app.get("/api/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    if (!rt.store.getSession(id)) {
      return c.json({ error: "session not found" }, 404);
    }
    return c.json(rt.store.getEvents(id));
  });

  /** Force one compaction of the live agent's history now (M3). */
  app.post("/api/sessions/:id/compact", async (c) => {
    const id = c.req.param("id");
    const session = rt.store.getSession(id);
    if (!session) return c.json({ error: "session not found" }, 404);

    const agent = getAgent(rt, session);
    const report = await agent.compactNow();
    if (!report) {
      return c.json(
        { error: "compaction is not configured (set COMPACT_THRESHOLD_TOKENS)" },
        409,
      );
    }

    rt.store.saveMessages(id, agent.messages);
    rt.store.touch(id);
    rt.store.appendEvents(id, [
      {
        type: "mechanism",
        name: "compaction",
        phase: "compacted",
        data: {
          before: report.before,
          after: report.after,
          summarized: report.summarized,
          keptRecent: report.keptRecent,
          keptLeading: report.keptLeading,
          placement: report.placement,
          via: "api",
        },
        at: Date.now(),
      },
    ]);

    return c.json({
      before: report.before,
      after: report.after,
      summarized: report.summarized,
      keptRecent: report.keptRecent,
      keptLeading: report.keptLeading,
      placement: report.placement,
    });
  });

  /** M6: per-turn file snapshots recorded so far, scoped to this session. */
  app.get("/api/sessions/:id/checkpoints", (c) => {
    const id = c.req.param("id");
    if (!rt.store.getSession(id)) {
      return c.json({ error: "session not found" }, 404);
    }
    const prefix = `${id}-`;
    const turns = rt.checkpoints
      .listTurns()
      .filter((turnId) => turnId.startsWith(prefix))
      .map((turnId) => ({
        turnId,
        files: rt.checkpoints.list(turnId).map((snap) => ({
          path: snap.path,
          existed: snap.existed,
          size: snap.size,
          hash: snap.hash,
        })),
      }));
    return c.json({ turns });
  });

  /** M6: restore every file snapshotted in one turn, byte-for-byte. */
  app.post("/api/sessions/:id/checkpoints/:turnId/restore", async (c) => {
    const id = c.req.param("id");
    if (!rt.store.getSession(id)) {
      return c.json({ error: "session not found" }, 404);
    }
    const turnId = c.req.param("turnId");
    try {
      const report = await rt.checkpoints.restoreTurn(turnId);
      return c.json(report);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        404,
      );
    }
  });

  /** M7: the scheduled/background tasks registered for this session. */
  app.get("/api/sessions/:id/tasks", (c) => {
    const id = c.req.param("id");
    if (!rt.store.getSession(id)) {
      return c.json({ error: "session not found" }, 404);
    }
    const tasks = (rt.scheduler?.list() ?? []).filter((task) => task.name === id);
    return c.json(tasks);
  });

  /**
   * M7: schedule a prompt to run later (one-shot after/at, or interval). The
   * task runs a fresh nested `Agent` seeded from the session history; when it
   * settles the runtime re-injects the outcome and appends a `task.settled`.
   */
  app.post("/api/sessions/:id/schedule", async (c) => {
    const id = c.req.param("id");
    const session = rt.store.getSession(id);
    if (!session) return c.json({ error: "session not found" }, 404);
    if (!rt.scheduler) {
      return c.json(
        { error: "scheduler is disabled (SCHEDULER_ENABLED=false)" },
        409,
      );
    }

    const body = await readJson(c);
    const rawPrompt = body?.["prompt"];
    const prompt = typeof rawPrompt === "string" ? rawPrompt.trim() : "";
    if (prompt.length === 0) {
      return c.json({ error: "prompt is required" }, 400);
    }

    const afterMs = body?.["afterMs"];
    const at = body?.["at"];
    const intervalMs = body?.["intervalMs"];
    const timingCount = [afterMs, at, intervalMs].filter(
      (value) => value !== undefined && value !== null,
    ).length;
    if (timingCount !== 1) {
      return c.json(
        { error: "exactly one of afterMs, at, intervalMs is required" },
        400,
      );
    }

    const scheduler = rt.scheduler;
    const runScheduled = async (signal: AbortSignal): Promise<string> => {
      const agent = new Agent(
        { ...rt.agentConfig, cwd: session.cwd },
        `sched-${id}`,
        rt.store.getMessages(id),
      );
      let text = "";
      for await (const event of agent.run(prompt, signal)) {
        if (event.type === "assistant.message" && event.message.role === "assistant") {
          const content = event.message.content;
          if (typeof content === "string" && content.trim().length > 0) {
            text = content;
          }
        }
      }
      return text;
    };

    try {
      if (afterMs !== undefined) {
        if (typeof afterMs !== "number" || !Number.isFinite(afterMs) || afterMs < 0) {
          return c.json({ error: "afterMs must be a number >= 0" }, 400);
        }
        const handle = scheduler.scheduleAfter(afterMs, runScheduled, {
          name: id,
          idPrefix: "sched",
        });
        return c.json(handle.record());
      }

      if (at !== undefined) {
        const when =
          typeof at === "number" ? at : new Date(String(at)).getTime();
        if (!Number.isFinite(when)) {
          return c.json({ error: "at must be a timestamp or ISO date" }, 400);
        }
        const handle = scheduler.scheduleAt(when, runScheduled, {
          name: id,
          idPrefix: "sched",
        });
        return c.json(handle.record());
      }

      if (
        typeof intervalMs !== "number" ||
        !Number.isFinite(intervalMs) ||
        intervalMs <= 0
      ) {
        return c.json({ error: "intervalMs must be a number > 0" }, 400);
      }
      const handle = scheduler.scheduleInterval(intervalMs, runScheduled, {
        name: id,
        idPrefix: "sched",
      });
      return c.json(handle.record());
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
  });

  app.post("/api/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const session = rt.store.getSession(id);
    if (!session) return c.json({ error: "session not found" }, 404);

    const body = await readJson(c);
    const rawInput = body?.["input"];
    const input = typeof rawInput === "string" ? rawInput : "";
    if (input.trim().length === 0) {
      return c.json({ error: "input is required" }, 400);
    }

    const agent = getAgent(rt, session);

    return streamSSE(c, async (stream) => {
      try {
        for await (const event of agent.run(input, c.req.raw.signal)) {
          rt.store.appendEvents(id, [event]);
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
          // The turn is over: persist the context the model now sees and the
          // "what happened" log, then end the stream.
          if (event.type === "turn.end") break;
        }
      } finally {
        rt.store.saveMessages(id, agent.messages);
        rt.store.touch(id);
      }
    });
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));

  app.onError((err, c) => {
    console.error("[server] unhandled error:", err);
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  });

  return app;
}

async function start(config: ServerConfig): Promise<void> {
  const rt = await createRuntime(config);
  const app = buildApp(rt);

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(
      `[server] listening on http://localhost:${info.port} ` +
        `(model: ${config.model}, cwd: ${config.cwd}, db: ${config.dbFile})`,
    );
  });

  const shutdown = (): void => {
    rt.close();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  let config: ServerConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(
      `[server] configuration error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  await start(config);
}

main().catch((err) => {
  console.error(
    `[server] fatal: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
