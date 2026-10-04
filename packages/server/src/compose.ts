import {
  OpenRouterClient,
  ToolRegistry,
  buildSystemPrompt,
  builtinTools,
  messageText,
  unifiedDiff,
  type AgentConfig,
  type AgentEvent,
  type ChatMessage,
  type JSONSchema,
  type ToolDef,
  type ToolResult,
} from "@agent/core";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ServerConfig } from "./config.js";
import {
  SkillRegistry,
  createUseSkillTool,
} from "../../core/src/mechanisms/skills/index.js";
import {
  McpStdioClient,
  mcpResultText,
  type McpTool,
} from "../../core/src/mechanisms/mcp/index.js";
import {
  createTaskTool,
  type SubagentRun,
} from "../../core/src/mechanisms/subagent/index.js";
import {
  HookRunner,
  Policy,
  decide,
  loadHooksFile,
} from "../../core/src/mechanisms/hooks/index.js";
import { compactDetailed } from "../../core/src/mechanisms/compaction/index.js";
import { CheckpointStore } from "../../core/src/mechanisms/checkpoint/index.js";
import { Scheduler } from "../../core/src/mechanisms/scheduler/index.js";
import {
  MemoryStore,
  createMemoryTool,
  memorySystemSuffix,
  type MemoryEntry,
} from "../../core/src/mechanisms/memory/index.js";
import {
  Supervisor,
  createOrchestratorTools,
} from "../../core/src/mechanisms/orchestrator/index.js";
import { createToolSearchRegistry } from "../../core/src/mechanisms/tool-search/index.js";

/**
 * Composition root (the "L8" wiring step).
 *
 * The kernel knows nothing about *which* mechanism tools exist — it only knows
 * the `ToolDef` interface and relays `ToolResult.events`. This module is the
 * single place that turns server config into a concrete `ToolRegistry`:
 *
 *   builtin tools (always)
 *   + use_skill          (when `config.skillsDir` contains skill directories)
 *   + MCP tools          (one block per connected entry in `config.mcpServers`)
 *   + task               (subagent; builtin tools minus `task`)
 *
 * Ordering is left to `ToolRegistry.list()`, which sorts by name, so the tool
 * schema prefix stays stable across boots (prompt-cache friendly).
 *
 * Every mechanism tool is wrapped so its `ToolResult` carries one `mechanism`
 * event. The agent loop relays those events right after `tool.result`; they are
 * persisted and streamed, but never enter the model's context.
 */

export interface ComposedAgent {
  agentConfig: AgentConfig;
  /** Names of the skills loaded from `SKILLS_DIR` (empty when none). */
  skills: string[];
  /** Names of the MCP servers that connected successfully. */
  mcpServers: string[];
  /** Per-turn file snapshots (M6). Always opened; inert until a write. */
  checkpoints: CheckpointStore;
  /** Background/scheduled task runner (M7), unless `SCHEDULER_ENABLED=false`. */
  scheduler?: Scheduler;
  /**
   * M9 memory read-out (present only when `MEMORY_ENABLED=true`). `dir` is the
   * store directory; `count` and `entries` are **live getters**, so they reflect
   * facts the `memory` tool saved during the current process lifetime.
   */
  memories?: {
    dir: string;
    count: number;
    entries: MemoryEntry[];
    /** Whether the memory block is also injected into the system prompt. */
    systemInject: boolean;
  };
  /** M10 orchestrator supervisor (present only when `ORCHESTRATOR_ENABLED=true`). */
  supervisor?: Supervisor;
  /** Close every connected MCP stdio client. Safe to call more than once. */
  close(): void;
}

function mechanismEvent(name: string, phase: string, data?: unknown): AgentEvent {
  return { type: "mechanism", name, phase, data, at: Date.now() };
}

/**
 * M3 summarizer: turn the folded `middle` of a transcript into one dense
 * summary using the shared client. `instructions` is the text injected by a
 * `preCompact` hook. Streaming-only client, so we accumulate `chatStream`.
 */
async function summarizeMiddle(
  client: OpenRouterClient,
  model: string,
  middle: ChatMessage[],
  instructions?: string,
): Promise<string> {
  const transcript = middle
    .map((message) => `${message.role}: ${messageText(message)}`)
    .join("\n");
  const directive =
    "You compress a coding agent's conversation history into a dense, factual " +
    "summary. Preserve decisions, file paths, commands, errors, and open TODOs. " +
    "Return only the summary text.";
  const prompt =
    (instructions && instructions.trim().length > 0
      ? `${instructions.trim()}\n\n`
      : "") + `Summarize this transcript:\n\n${transcript}`;

  const result = await client.chatStream({
    model,
    messages: [
      { role: "system", content: directive },
      { role: "user", content: prompt },
    ],
    temperature: 0,
  });
  return (result.message.content ?? "").trim();
}

/** Wrap a `ToolDef` so each call appends exactly one observable event. */
function observable(
  tool: ToolDef,
  mechanism: string,
  describe: (
    input: Record<string, unknown>,
    result: ToolResult,
  ) => { phase: string; data?: unknown },
): ToolDef {
  return {
    ...tool,
    async execute(input, ctx) {
      const result = await tool.execute(input, ctx);
      const { phase, data } = describe(input, result);
      return { ...result, events: [mechanismEvent(mechanism, phase, data)] };
    },
  };
}

/**
 * M6: wrap a file-mutating tool so its target is snapshotted *before* the
 * executor runs. The snapshot lands in the current loop turn (`ctx.turnId`), so
 * `POST /checkpoints/:turnId/restore` can put the exact bytes back. Other tools
 * are left untouched, and with no `ctx.checkpoints` this is a pass-through.
 */
function checkpointed(tool: ToolDef): ToolDef {
  return {
    ...tool,
    async execute(input, ctx) {
      if (typeof input["path"] === "string") {
        await ctx.checkpoints?.snapshot(
          path.resolve(ctx.cwd, input["path"]),
          ctx.turnId,
        );
      }
      return tool.execute(input, ctx);
    },
  };
}

/** Tool names whose files must be checkpointed before mutation. */
const CHECKPOINTED_TOOLS = new Set(["write_file", "edit_file"]);

/** Tool names whose file mutation should emit a unified-diff event (M8). */
const DIFFED_TOOLS = new Set(["write_file", "edit_file"]);

/** Read a file's text, treating "missing" as the empty string. */
async function readTextOrEmpty(abs: string): Promise<string> {
  try {
    return await readFile(abs, "utf8");
  } catch {
    return "";
  }
}

/** Count added/removed lines in a hunks-only unified diff. */
function countDiffLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/**
 * M8: wrap a file-mutating tool so it diffs its target before/after execution
 * and appends one `mechanism` diff event when the bytes changed. Observability
 * only — `patch` never enters the model's context. Emits nothing on no change
 * (including a failed call, which the tool already reports).
 */
function diffed(tool: ToolDef): ToolDef {
  return {
    ...tool,
    async execute(input, ctx) {
      const rel = typeof input["path"] === "string" ? input["path"] : undefined;
      if (!rel) return tool.execute(input, ctx);

      const abs = path.resolve(ctx.cwd, rel);
      const before = await readTextOrEmpty(abs);
      const result = await tool.execute(input, ctx);
      if (result.isError) return result;

      const after = await readTextOrEmpty(abs);
      if (before === after) return result;

      const patch = unifiedDiff(before, after, { context: 3, maxChars: 20_000 });
      const { added, removed } = countDiffLines(patch);
      return {
        ...result,
        events: [
          ...(result.events ?? []),
          mechanismEvent("diff", "file", { path: rel, added, removed, patch }),
        ],
      };
    },
  };
}

/** Build a `ToolDef` that proxies one MCP tool over the shared stdio client. */
function mcpToolDef(
  client: McpStdioClient,
  server: string,
  tool: McpTool,
): ToolDef {
  const def: ToolDef = {
    name: tool.name,
    description:
      tool.description ?? `MCP tool \`${tool.name}\` from server "${server}".`,
    // MCP tools are external side effects we cannot statically classify; treat
    // them as non-read-only so the permission layer can gate them.
    readOnly: false,
    parameters: (tool.inputSchema ?? {
      type: "object",
      properties: {},
    }) as JSONSchema,
    async execute(input) {
      const result = await client.callTool(tool.name, input);
      return { output: mcpResultText(result), isError: result.isError === true };
    },
  };
  return observable(def, `mcp:${server}`, (input, result) => ({
    phase: result.isError ? "error" : "called",
    data: { server, tool: tool.name, arguments: input },
  }));
}

export async function composeAgent(config: ServerConfig): Promise<ComposedAgent> {
  const client = new OpenRouterClient({
    apiKey: config.apiKey,
    referer: config.referer,
    title: config.title,
  });

  /* ------------------------------------------------- hooks / permissions (M6) */

  const hooks = config.hooksFile
    ? new HookRunner(await loadHooksFile(config.hooksFile))
    : undefined;
  console.log(
    hooks
      ? `[server] hooks: ${hooks.list().length} loaded from ${config.hooksFile}`
      : "[server] hooks: none (HOOKS_FILE unset)",
  );

  const policy = config.policyFile
    ? await Policy.fromFile(config.policyFile)
    : undefined;
  console.log(
    policy
      ? `[server] policy: ${policy.list().length} rule(s) from ${config.policyFile}`
      : "[server] policy: none (POLICY_FILE unset)",
  );

  // The gate exists when either half is configured; a missing half falls back
  // to the mechanism default (empty policy ⇒ ask, no hooks ⇒ no rewrites).
  const gate: AgentConfig["gate"] =
    hooks || policy
      ? async (request) => {
          const decision = await decide(
            policy ?? new Policy([]),
            hooks ?? new HookRunner(),
            request,
          );
          return {
            decision: decision.kind,
            reason: decision.reason,
            input: decision.input,
            records: decision.trace,
            mutated: decision.mutated,
          };
        }
      : undefined;

  /* ------------------------------------------------------- compaction (M3) */

  const compaction: AgentConfig["compaction"] =
    config.compactThresholdTokens > 0
      ? {
          thresholdTokens: config.compactThresholdTokens,
          async compact(messages, instructions) {
            const result = await compactDetailed(messages, {
              keepRecent: config.compactKeepRecent,
              keepLeading: config.compactKeepLeading,
              placement: config.compactPlacement,
              summarize: (middle) =>
                summarizeMiddle(client, config.model, middle, instructions),
            });
            return {
              messages: result.messages,
              info: {
                summarized: result.summarized,
                keptLeading: result.keptLeading,
                keptRecent: result.keptRecent,
                placement: config.compactPlacement,
                summaryIndex: result.summaryIndex,
              },
            };
          },
        }
      : undefined;
  console.log(
    compaction
      ? `[server] compaction: threshold=${config.compactThresholdTokens} tok ` +
          `keepRecent=${config.compactKeepRecent} keepLeading=${config.compactKeepLeading} ` +
          `placement=${config.compactPlacement}`
      : "[server] compaction: none (COMPACT_THRESHOLD_TOKENS unset/0)",
  );

  /* ------------------------------------------------ checkpoints (M6) */

  const checkpoints = await CheckpointStore.open(config.checkpointDir);
  console.log(`[server] checkpoints: ${config.checkpointDir}`);

  /* ------------------------------------------------ scheduler (M7) */

  const scheduler = config.schedulerEnabled ? new Scheduler() : undefined;
  console.log(
    scheduler
      ? "[server] scheduler: enabled"
      : "[server] scheduler: disabled (SCHEDULER_ENABLED=false)",
  );

  const tools = new ToolRegistry();
  for (const tool of builtinTools()) {
    let wrapped = tool;
    if (CHECKPOINTED_TOOLS.has(tool.name)) wrapped = checkpointed(wrapped);
    if (DIFFED_TOOLS.has(tool.name)) wrapped = diffed(wrapped);
    tools.register(wrapped);
  }

  /* ---------------------------------------------------------------- skills */

  const skills: string[] = [];
  const skillRegistry = await SkillRegistry.scan(config.skillsDir);
  if (skillRegistry.size() > 0) {
    tools.register(
      observable(createUseSkillTool(skillRegistry), "skills", (input, result) => ({
        phase: result.isError ? "error" : "loaded",
        data: {
          skill: typeof input["name"] === "string" ? input["name"] : undefined,
          reference:
            typeof input["reference"] === "string" ? input["reference"] : undefined,
        },
      })),
    );
    skills.push(...skillRegistry.list().map((meta) => meta.name));
    console.log(
      `[server] skills: ${skills.length} loaded from ${config.skillsDir} ` +
        `(${skills.join(", ")})`,
    );
  } else {
    console.log(`[server] skills: none in ${config.skillsDir}`);
  }

  /* ------------------------------------------------------------------- MCP */

  const mcpClients: McpStdioClient[] = [];
  const mcpServers: string[] = [];
  for (const server of config.mcpServers) {
    const mcp = new McpStdioClient({
      command: server.command,
      args: server.args,
      env: server.env,
      // Launch MCP children from the repo root so relative `args` (fixtures,
      // local servers) resolve predictably, independent of AGENT_CWD.
      cwd: config.repoRoot,
    });
    try {
      await mcp.connect();
      const list = await mcp.listTools();
      for (const tool of list) tools.register(mcpToolDef(mcp, server.name, tool));
      mcpClients.push(mcp);
      mcpServers.push(server.name);
      console.log(
        `[server] mcp "${server.name}": ${list.length} tool(s) ` +
          `(${list.map((t) => t.name).join(", ")})`,
      );
    } catch (err) {
      // A broken MCP server must not take the whole agent down.
      mcp.close();
      console.warn(
        `[server] mcp "${server.name}" failed to connect; skipping: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /* -------------------------------------------------------------- subagent */

  const pendingRuns: SubagentRun[] = [];
  const baseTask = createTaskTool({
    client,
    model: config.model,
    permissionMode: config.permissionMode,
    maxSteps: config.subagentMaxSteps,
    onRun: ({ run }) => pendingRuns.push(run),
  });
  const task: ToolDef = {
    ...baseTask,
    async execute(input, ctx) {
      const result = await baseTask.execute(input, ctx);
      const run = pendingRuns.shift();
      const data = run
        ? {
            steps: run.steps,
            toolCalls: run.toolCalls,
            childSessionId: run.sessionId,
            usage: run.summary,
            error: run.error,
          }
        : undefined;
      return {
        ...result,
        events: [
          mechanismEvent("subagent", result.isError ? "error" : "completed", data),
        ],
      };
    },
  };
  tools.register(task);

  /* ---------------------------------------------------------------- memory (M9) */

  // `memories` is a live read-out: `count`/`entries` are getters closing over the
  // store, so a `memory` tool `save` during a turn is immediately visible to
  // `GET /api/memories`. `systemInject` mirrors `MEMORY_SYSTEM_INJECT`.
  let memoryStore: MemoryStore | undefined;
  let memoryReadout: ComposedAgent["memories"];
  if (config.memoryEnabled) {
    const store = await MemoryStore.open(config.memoryDir);
    memoryStore = store;
    tools.register(
      observable(createMemoryTool(store), "memory", (input, result) => ({
        phase: result.isError ? "error" : "called",
        data: {
          action:
            typeof input["action"] === "string" ? input["action"] : undefined,
          count: store.size(),
        },
      })),
    );
    memoryReadout = {
      dir: store.dir(),
      get count() {
        return store.size();
      },
      get entries() {
        return store.all();
      },
      systemInject: config.memorySystemInject,
    };
    console.log(
      `[server] memory: enabled (dir=${config.memoryDir}, ` +
        `entries=${store.size()}, systemInject=${config.memorySystemInject})`,
    );
  } else {
    console.log("[server] memory: disabled (MEMORY_ENABLED unset/false)");
  }

  /* ---------------------------------------------------------- orchestrator (M10) */

  let supervisor: Supervisor | undefined;
  if (config.orchestratorEnabled) {
    supervisor = new Supervisor({
      client,
      model: config.model,
      cwd: config.cwd,
      permissionMode: config.permissionMode,
      maxSteps: config.subagentMaxSteps,
      // Minimal observability: worker messages are normally consumed by the
      // coordinator's `wait_for` tool during a turn. Anything left unacked is
      // visible through `GET /api/workers` (registry + pending mailbox). We do
      // NOT re-inject into a session here because the supervisor is not bound to
      // one session (unlike the M7 scheduler); see `docs/runs/int-c.md`.
      onMessage: (message) => {
        console.log(
          `[server] worker message: ${message.type} from=${message.from}` +
            (message.subject ? ` subject="${message.subject}"` : ""),
        );
      },
    });
    for (const tool of createOrchestratorTools(supervisor)) {
      const wrapped =
        tool.name === "spawn_worker"
          ? limitedSpawns(tool, supervisor, config.orchestratorMaxWorkers)
          : tool;
      tools.register(
        observable(wrapped, "orchestrator", (_input, result) => ({
          phase: wrapped.name,
          data: result.isError ? { error: true } : { tool: wrapped.name },
        })),
      );
    }
    console.log(
      `[server] orchestrator: enabled (maxWorkers=${config.orchestratorMaxWorkers})`,
    );
  } else {
    console.log(
      "[server] orchestrator: disabled (ORCHESTRATOR_ENABLED unset/false)",
    );
  }

  /* ---------------------------------------------------------- tool-search (M11) */

  console.log(
    `[server] tools (${tools.list().length}): ` +
      `${tools.list().map((t) => t.name).join(", ")}`,
  );

  // M11: expose the *fully built* registry through the two-tool facade. Wrapping
  // last means every mechanism wired above is still discoverable via
  // `tool_search`/`tool_call`, while the parent Agent's prefix only carries those
  // two schemas. Caveat: the facade's own `readOnly:false` drives the permission
  // layer, so a per-tool gate must resolve the inner tool (mechanism doc).
  let exposedTools = tools;
  if (config.toolSearchEnabled) {
    exposedTools = createToolSearchRegistry(tools);
    console.log(
      `[server] tool-search: enabled (${tools.list().length} real tools ` +
        `behind ${exposedTools.list().map((t) => t.name).join(", ")})`,
    );
  }

  const agentConfig: AgentConfig = {
    client,
    model: config.model,
    tools: exposedTools,
    cwd: config.cwd,
    permissionMode: config.permissionMode,
  };
  if (gate) agentConfig.gate = gate;
  if (hooks) agentConfig.hooks = hooks;
  if (compaction) agentConfig.compaction = compaction;
  agentConfig.checkpoints = checkpoints;

  // M9 optional system-prompt injection. The base must be assembled explicitly
  // because appending a suffix requires a full `systemPromptOverride` (the loop
  // otherwise builds the prompt itself). Cache caveat: appending at the very END
  // is the append-only-safe position (M2 §c′ / M9 §4), but this block is frozen
  // at boot and re-writes as memories accumulate across restarts; off by default.
  if (memoryStore && config.memorySystemInject) {
    const suffix = memorySystemSuffix(memoryStore.all());
    const base = await buildSystemPrompt({ cwd: config.cwd });
    agentConfig.systemPromptOverride = base.text + suffix;
    console.log(
      `[server] memory: system injection on (suffix chars=${suffix.length})`,
    );
  }

  let closed = false;
  return {
    agentConfig,
    skills,
    mcpServers,
    checkpoints,
    scheduler,
    memories: memoryReadout,
    supervisor,
    close() {
      if (closed) return;
      closed = true;
      for (const mcp of mcpClients) mcp.close();
      // Stop timers and cancel in-flight scheduled work; fire-and-forget since
      // the process is on its way out.
      void scheduler?.shutdown();
      // Abort active workers and drop mailbox waiters so their timers do not
      // keep the event loop alive.
      void supervisor?.stopAll();
      supervisor?.dispose();
    },
  };
}

/**
 * M10: cap concurrent active workers at `ORCHESTRATOR_MAX_WORKERS`. We wrap the
 * mechanism's `spawn_worker` tool (rather than editing the mechanism directory),
 * so the limit is enforced host-side and observable as a tool error.
 */
function limitedSpawns(
  tool: ToolDef,
  supervisor: Supervisor,
  max: number,
): ToolDef {
  return {
    ...tool,
    async execute(input, ctx) {
      const active = supervisor.registry
        .list()
        .filter(
          (worker) =>
            worker.status === "starting" ||
            worker.status === "running" ||
            worker.status === "blocked",
        ).length;
      if (active >= max) {
        return {
          output:
            `orchestrator: ${active} worker(s) already active ` +
            `(ORCHESTRATOR_MAX_WORKERS=${max}); wait for one to finish.`,
          isError: true,
        };
      }
      return tool.execute(input, ctx);
    },
  };
}
