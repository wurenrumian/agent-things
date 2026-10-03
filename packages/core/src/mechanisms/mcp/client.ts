import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolSchema } from "../../types.js";
import { StdioTransport, type TransportOptions } from "./transport.js";

/**
 * Hand-rolled MCP stdio client: the slice of the protocol this project needs.
 *
 *   initialize  -> capabilities handshake
 *   tools/list  -> enumerate tools (paginated via `nextCursor`)
 *   tools/call  -> invoke a tool
 *
 * The server side is a tiny fixture launched with `node` (see
 * `fixtures/echo-server.mjs`), so the round-trip is real JSON-RPC, not a mock.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Path to the bundled fixture MCP server (plain ESM, run by `node`). */
export const FIXTURE_SERVER_PATH = path.join(HERE, "fixtures", "echo-server.mjs");

/** Protocol revision we implement; matches the fixture's default. */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface McpTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments, as MCP names it. */
  inputSchema?: Record<string, unknown>;
}

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: McpServerInfo;
}

export interface McpTextContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpToolCallResult {
  content?: McpTextContent[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface McpClientOptions extends Partial<TransportOptions> {
  /** Override the launched executable (defaults to the current node). */
  command?: string;
  /** Override the launched arguments (defaults to the fixture server). */
  args?: string[];
}

export class McpStdioClient {
  private readonly transport: StdioTransport;
  private initialized = false;

  constructor(opts: McpClientOptions = {}) {
    this.transport = new StdioTransport({
      command: opts.command ?? process.execPath,
      args: opts.args ?? [FIXTURE_SERVER_PATH],
      cwd: opts.cwd,
      env: opts.env,
    });
  }

  /** MCP `initialize` plus the `notifications/initialized` follow-up. */
  async connect(): Promise<McpInitializeResult> {
    const result = await this.transport.request<McpInitializeResult>("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: "agent-core-mcp-client", version: "0.0.0" },
    });
    this.transport.notify("notifications/initialized", {});
    this.initialized = true;
    return result;
  }

  /** MCP `tools/list`, following `nextCursor` until the server says done. */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.transport.request<{
        tools?: McpTool[];
        nextCursor?: string;
      }>("tools/list", cursor === undefined ? {} : { cursor });
      tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  }

  /** MCP `tools/call`. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    return this.transport.request<McpToolCallResult>("tools/call", {
      name,
      arguments: args,
    });
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  close(): void {
    this.transport.close();
  }
}

/**
 * Map MCP tools to our wire `ToolSchema` in a **deterministic order**.
 *
 * Stable ordering is not cosmetic: OpenRouter/provider prefix caching hashes the
 * tools array, so the same set enumerated in a different order is a cache miss
 * (see docs/runs/m1-cache.md §1.2). We sort by name, matching the convention in
 * `ToolRegistry.list()`.
 */
export function mcpToolsToSchemas(tools: McpTool[]): ToolSchema[] {
  return [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
      },
    }));
}

/** Concatenate the text blocks of an MCP tool-call result. */
export function mcpResultText(result: McpToolCallResult): string {
  return (result.content ?? [])
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}
