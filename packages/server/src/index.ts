import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  Agent,
  OpenRouterClient,
  Store,
  ToolRegistry,
  builtinTools,
  type AgentConfig,
  type SessionMeta,
} from "@agent/core";
import { loadConfig, type ServerConfig } from "./config.js";

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
}

function createRuntime(config: ServerConfig): Runtime {
  const client = new OpenRouterClient({
    apiKey: config.apiKey,
    referer: config.referer,
    title: config.title,
  });

  const tools = new ToolRegistry();
  for (const tool of builtinTools()) tools.register(tool);

  const agentConfig: AgentConfig = {
    client,
    model: config.model,
    tools,
    cwd: config.cwd,
    permissionMode: config.permissionMode,
  };

  return {
    config,
    store: new Store(config.dbFile),
    agents: new Map<string, Agent>(),
    agentConfig,
  };
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

function start(config: ServerConfig): void {
  const rt = createRuntime(config);
  const app = buildApp(rt);

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(
      `[server] listening on http://localhost:${info.port} ` +
        `(model: ${config.model}, cwd: ${config.cwd}, db: ${config.dbFile})`,
    );
  });
}

function main(): void {
  let config: ServerConfig;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(
      `[server] configuration error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  start(config);
}

main();
