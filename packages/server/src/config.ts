import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PermissionMode } from "@agent/core";

/**
 * Server configuration.
 *
 * Everything comes from the environment, with a tiny hand-written `.env` loader
 * (no `dotenv` dependency, per the brief). The contract is frozen in
 * `docs/CONTRACT.md`; this file is the single place that interprets it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Walk up from the source directory until we find the workspace root marker. */
export function findRepoRoot(start: string = HERE): string {
  let dir = path.resolve(start);
  while (true) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not locate the repo root (no pnpm-workspace.yaml above ${start}).`,
      );
    }
    dir = parent;
  }
}

/**
 * Minimal `.env` parser. Reads `KEY=value` lines, ignores comments/blanks, and
 * strips a single layer of matching quotes. Only fills keys that are not already
 * present in `process.env`, so real environment variables always win.
 */
export function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7) : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!key) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

/** One entry of `MCP_SERVERS`: a stdio MCP server to connect at startup. */
export interface McpServerConfig {
  /** Human-readable id, used for `/api/mechanisms` and log lines. */
  name: string;
  /** Executable to launch (e.g. `node`, `npx`, `uvx`). */
  command: string;
  /** Arguments passed to the executable. */
  args: string[];
  /** Extra environment variables for the child process. */
  env?: Record<string, string>;
}

export interface ServerConfig {
  /** Repo root; DATA_DIR defaults and AGENT_CWD resolve against it. */
  repoRoot: string;
  apiKey: string;
  model: string;
  referer?: string;
  title?: string;
  port: number;
  /** Absolute path to the sqlite file (`${DATA_DIR}/agent.db`). */
  dbFile: string;
  permissionMode: PermissionMode;
  /** Directory the agent operates on. */
  cwd: string;
  /** Absolute directory scanned for skill subdirectories (each has SKILL.md). */
  skillsDir: string;
  /** MCP servers to connect at startup (empty = none). */
  mcpServers: McpServerConfig[];
  /** Step ceiling handed to each nested subagent (`task` tool). */
  subagentMaxSteps: number;
  /** Absolute path to a hooks JSON file (`HOOKS_FILE`); unset = hooks off. */
  hooksFile?: string;
  /** Absolute path to a policy JSON file (`POLICY_FILE`); unset = policy off. */
  policyFile?: string;
  /** Auto-compaction trigger in estimated tokens; `0` = compaction off. */
  compactThresholdTokens: number;
  /** Messages kept verbatim at the tail of a compaction (default `8`). */
  compactKeepRecent: number;
  /** Messages kept verbatim before the summarized span (default `1`). */
  compactKeepLeading: number;
  /** Where the summary lands (`COMPACT_PLACEMENT`, default `spliced`). */
  compactPlacement: CompactPlacement;
}

/** Summary placement, mirroring the compaction mechanism's union. */
export type CompactPlacement = "spliced" | "leading";

function parsePermissionMode(raw: string | undefined): PermissionMode {
  if (raw === undefined || raw === "") return "yolo";
  if (raw === "yolo" || raw === "standard" || raw === "readonly") return raw;
  throw new Error(
    `Invalid PERMISSION_MODE "${raw}" (expected yolo | standard | readonly).`,
  );
}

function parsePositiveInt(raw: string | undefined, fallback: number, key: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${key} "${raw}" (expected a positive integer).`);
  }
  return value;
}

/** Like {@link parsePositiveInt} but allows `0` (used for "off" thresholds). */
function parseNonNegativeInt(raw: string | undefined, fallback: number, key: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${key} "${raw}" (expected a non-negative integer).`);
  }
  return value;
}

/** An optional file path, resolved against the repo root when relative. */
function resolveOptionalPath(root: string, raw: string | undefined): string | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  return path.isAbsolute(text) ? text : path.resolve(root, text);
}

function parsePlacement(raw: string | undefined): CompactPlacement {
  const text = raw?.trim();
  if (!text) return "spliced";
  if (text === "spliced" || text === "leading") return text;
  throw new Error(`Invalid COMPACT_PLACEMENT "${raw}" (expected spliced | leading).`);
}

/**
 * Parse `MCP_SERVERS`: a JSON array of `{ name, command, args, env? }`. Absent
 * or empty means "no MCP servers" — the kernel then behaves exactly as before.
 */
function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  const text = (raw ?? "").trim();
  if (text === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Invalid MCP_SERVERS JSON: ${err instanceof Error ? err.message : String(err)}. ` +
        `Expected an array like [{"name":"echo","command":"node","args":["server.mjs"]}].`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid MCP_SERVERS: expected a JSON array.");
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Invalid MCP_SERVERS[${index}]: expected an object.`);
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record["name"] === "string" ? record["name"].trim() : "";
    const command =
      typeof record["command"] === "string" ? record["command"].trim() : "";
    if (name === "" || command === "") {
      throw new Error(
        `Invalid MCP_SERVERS[${index}]: "name" and "command" are required strings.`,
      );
    }
    const rawArgs = record["args"];
    if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
      throw new Error(`Invalid MCP_SERVERS[${index}].args: expected an array.`);
    }
    const args = (rawArgs ?? []).map((arg, argIndex) => {
      if (typeof arg !== "string") {
        throw new Error(
          `Invalid MCP_SERVERS[${index}].args[${argIndex}]: expected a string.`,
        );
      }
      return arg;
    });
    let env: Record<string, string> | undefined;
    const rawEnv = record["env"];
    if (rawEnv !== undefined) {
      if (typeof rawEnv !== "object" || rawEnv === null || Array.isArray(rawEnv)) {
        throw new Error(`Invalid MCP_SERVERS[${index}].env: expected an object.`);
      }
      env = {};
      for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
        if (typeof value !== "string") {
          throw new Error(
            `Invalid MCP_SERVERS[${index}].env.${key}: expected a string.`,
          );
        }
        env[key] = value;
      }
    }
    return env ? { name, command, args, env } : { name, command, args };
  });
}

export function loadConfig(): ServerConfig {
  const repoRoot = findRepoRoot();
  loadDotEnv(path.join(repoRoot, ".env"));

  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is missing. Add it to the repo-root .env file " +
        "(see docs/CONTRACT.md) or export it in the environment.",
    );
  }

  const port = Number.parseInt(process.env["PORT"] ?? "8787", 10);
  if (!Number.isFinite(port)) {
    throw new Error(`Invalid PORT "${process.env["PORT"]}".`);
  }

  const dataDir = path.resolve(repoRoot, process.env["DATA_DIR"] ?? "./data");
  const agentCwd = process.env["AGENT_CWD"]
    ? path.resolve(repoRoot, process.env["AGENT_CWD"])
    : repoRoot;

  const rawSkillsDir = process.env["SKILLS_DIR"]?.trim();

  return {
    repoRoot,
    apiKey,
    model: process.env["OPENROUTER_MODEL"] ?? "anthropic/claude-sonnet-4.5",
    referer: process.env["OPENROUTER_REFERER"],
    title: process.env["OPENROUTER_TITLE"],
    port,
    dbFile: path.join(dataDir, "agent.db"),
    permissionMode: parsePermissionMode(process.env["PERMISSION_MODE"]),
    cwd: agentCwd,
    skillsDir: path.resolve(
      repoRoot,
      rawSkillsDir && rawSkillsDir.length > 0 ? rawSkillsDir : "./skills",
    ),
    mcpServers: parseMcpServers(process.env["MCP_SERVERS"]),
    subagentMaxSteps: parsePositiveInt(
      process.env["SUBAGENT_MAX_STEPS"],
      12,
      "SUBAGENT_MAX_STEPS",
    ),
    hooksFile: resolveOptionalPath(repoRoot, process.env["HOOKS_FILE"]),
    policyFile: resolveOptionalPath(repoRoot, process.env["POLICY_FILE"]),
    compactThresholdTokens: parseNonNegativeInt(
      process.env["COMPACT_THRESHOLD_TOKENS"],
      0,
      "COMPACT_THRESHOLD_TOKENS",
    ),
    compactKeepRecent: parseNonNegativeInt(
      process.env["COMPACT_KEEP_RECENT"],
      8,
      "COMPACT_KEEP_RECENT",
    ),
    compactKeepLeading: parseNonNegativeInt(
      process.env["COMPACT_KEEP_LEADING"],
      1,
      "COMPACT_KEEP_LEADING",
    ),
    compactPlacement: parsePlacement(process.env["COMPACT_PLACEMENT"]),
  };
}
