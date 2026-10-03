import type { JSONSchema, ToolSchema } from "../types.js";

/**
 * Tool layer. A tool is: a schema (what the model sees) + an executor (what we
 * run). `readOnly` feeds the permission layer.
 */

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: JSONSchema;
  readOnly: boolean;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(tool: ToolDef): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  list(): ToolDef[] {
    // Stable ordering matters: unstable tool order causes prompt-cache misses
    // (a real bug the Codex team hit with MCP). Sort by name, once, always.
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  schemas(): ToolSchema[] {
    return this.list().map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
}
