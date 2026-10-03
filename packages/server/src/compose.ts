import {
  OpenRouterClient,
  ToolRegistry,
  builtinTools,
  type AgentConfig,
  type AgentEvent,
  type JSONSchema,
  type ToolDef,
  type ToolResult,
} from "@agent/core";
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
  /** Close every connected MCP stdio client. Safe to call more than once. */
  close(): void;
}

function mechanismEvent(name: string, phase: string, data?: unknown): AgentEvent {
  return { type: "mechanism", name, phase, data, at: Date.now() };
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

  const tools = new ToolRegistry();
  for (const tool of builtinTools()) tools.register(tool);

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

  console.log(
    `[server] tools (${tools.list().length}): ` +
      `${tools.list().map((t) => t.name).join(", ")}`,
  );

  const agentConfig: AgentConfig = {
    client,
    model: config.model,
    tools,
    cwd: config.cwd,
    permissionMode: config.permissionMode,
  };

  let closed = false;
  return {
    agentConfig,
    skills,
    mcpServers,
    close() {
      if (closed) return;
      closed = true;
      for (const mcp of mcpClients) mcp.close();
    },
  };
}
