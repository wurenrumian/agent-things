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
}

function parsePermissionMode(raw: string | undefined): PermissionMode {
  if (raw === undefined || raw === "") return "yolo";
  if (raw === "yolo" || raw === "standard" || raw === "readonly") return raw;
  throw new Error(
    `Invalid PERMISSION_MODE "${raw}" (expected yolo | standard | readonly).`,
  );
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
  };
}
