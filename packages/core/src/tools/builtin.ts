import { exec } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolContext, ToolDef, ToolResult } from "./registry.js";

const execAsync = promisify(exec);

/** Resolve a path relative to cwd and refuse to escape it. */
function resolveInside(cwd: string, target: string): string {
  const abs = path.resolve(cwd, target);
  const rel = path.relative(cwd, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes working directory: ${target}`);
  }
  return abs;
}

function numberArg(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  return typeof v === "number" ? v : undefined;
}

function stringArg(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string") throw new Error(`missing string argument "${key}"`);
  return v;
}

export const readFileTool: ToolDef = {
  name: "read_file",
  description:
    "Read a UTF-8 text file inside the working directory. Returns numbered lines.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the working directory." },
      offset: { type: "integer", description: "1-based first line to read." },
      limit: { type: "integer", description: "Max lines to read (default 400)." },
    },
    required: ["path"],
  },
  async execute(input, ctx) {
    const abs = resolveInside(ctx.cwd, stringArg(input, "path"));
    const raw = await readFile(abs, "utf8");
    const lines = raw.split("\n");
    const offset = Math.max(1, numberArg(input, "offset") ?? 1);
    const limit = Math.min(2000, numberArg(input, "limit") ?? 400);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice
      .map((l, i) => `${offset + i}\t${l}`)
      .join("\n");
    return { output: numbered };
  },
};

export const writeFileTool: ToolDef = {
  name: "write_file",
  description:
    "Create or overwrite a UTF-8 text file inside the working directory. Parent directories are created.",
  readOnly: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  async execute(input, ctx) {
    const abs = resolveInside(ctx.cwd, stringArg(input, "path"));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, stringArg(input, "content"), "utf8");
    return { output: `wrote ${input["path"]}` };
  },
};

export const editFileTool: ToolDef = {
  name: "edit_file",
  description:
    "Replace an exact, unique string in a file. Fails if old_string is not found or is ambiguous.",
  readOnly: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(input, ctx) {
    const abs = resolveInside(ctx.cwd, stringArg(input, "path"));
    const oldString = stringArg(input, "old_string");
    const newString = stringArg(input, "new_string");
    const raw = await readFile(abs, "utf8");
    const first = raw.indexOf(oldString);
    if (first === -1) throw new Error("old_string not found");
    if (raw.indexOf(oldString, first + 1) !== -1) {
      throw new Error("old_string is not unique; add more context");
    }
    await writeFile(abs, raw.replace(oldString, newString), "utf8");
    return { output: `edited ${input["path"]}` };
  },
};

export const listDirTool: ToolDef = {
  name: "list_dir",
  description: "List entries in a directory inside the working directory.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Defaults to the working directory." },
    },
  },
  async execute(input, ctx) {
    const rel = typeof input["path"] === "string" ? input["path"] : ".";
    const abs = resolveInside(ctx.cwd, rel);
    const entries = await readdir(abs, { withFileTypes: true });
    const lines = await Promise.all(
      entries.map(async (e) => {
        if (e.isDirectory()) return `${e.name}/`;
        try {
          const info = await stat(path.join(abs, e.name));
          return `${e.name}\t${info.size}b`;
        } catch {
          return e.name;
        }
      }),
    );
    return { output: lines.join("\n") };
  },
};

export const runShellTool: ToolDef = {
  name: "run_shell",
  description:
    "Run a shell command in the working directory and return stdout/stderr. Use for builds, tests, git, and other CLI tools.",
  readOnly: false,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout_ms: { type: "integer", description: "Default 30000." },
    },
    required: ["command"],
  },
  async execute(input, ctx) {
    const command = stringArg(input, "command");
    const timeout = numberArg(input, "timeout_ms") ?? 30_000;
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: ctx.cwd,
        timeout,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      return { output: out || "(no output)" };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const out = [e.stdout?.trim(), e.stderr?.trim()]
        .filter(Boolean)
        .join("\n");
      return { output: out || e.message || "command failed", isError: true };
    }
  },
};

export function builtinTools(): ToolDef[] {
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirTool,
    runShellTool,
  ];
}
