#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  Agent,
  OpenRouterClient,
  ToolRegistry,
  builtinTools,
  type PermissionMode,
  type Usage,
} from "@agent/core";

/**
 * `agent-things` — a terminal front-end for the *same* `@agent/core` kernel the
 * server and web app run. It owns no agent logic: it parses a few flags, wires
 * an `OpenRouterClient` + `builtinTools()` registry into an `Agent`, then
 * streams the resulting `AgentEvent`s to stdout. One-shot (`--message` /
 * positional) or an interactive `node:readline` REPL.
 *
 * No runtime dependency beyond `@agent/core` (and `tsx` to run TypeScript).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface CliOptions {
  cwd?: string;
  model?: string;
  permissionMode?: PermissionMode;
  message?: string;
  help: boolean;
  positional: string[];
}

/* ------------------------------------------------------- tiny arg parser */

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { help: false, positional: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // Support both `--flag value` and `--flag=value`.
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };

    switch (flag) {
      case "--help":
      case "-h":
        opts.help = true;
        break;
      case "--cwd":
        opts.cwd = value();
        break;
      case "--model":
        opts.model = value();
        break;
      case "--permission-mode": {
        const mode = value();
        if (mode !== "yolo" && mode !== "standard" && mode !== "readonly") {
          throw new Error(
            `invalid --permission-mode "${mode}" (expected yolo | standard | readonly)`,
          );
        }
        opts.permissionMode = mode;
        break;
      }
      case "--message":
      case "-m":
        opts.message = value();
        break;
      default:
        if (flag.startsWith("-") && flag !== "-") {
          throw new Error(`unknown option "${flag}"`);
        }
        opts.positional.push(arg);
        break;
    }
  }

  return opts;
}

function printUsage(out: NodeJS.WriteStream): void {
  out.write(
    [
      "agent-things — drive the @agent/core kernel from the terminal.",
      "",
      "Usage:",
      "  agent-things [options] [message...]",
      "",
      "Options:",
      "  --cwd <dir>               Working directory for tools (default: cwd)",
      "  --model <id>              OpenRouter model id (default: OPENROUTER_MODEL)",
      "  --permission-mode <mode>  yolo | standard | readonly (default: yolo)",
      "  --message, -m <text>      Run one turn, then exit",
      "  --help, -h                Show this help",
      "",
      "With no message, starts a REPL. Configuration is read from the repo-root",
      ".env (OPENROUTER_API_KEY, OPENROUTER_MODEL, ...); real env vars win.",
      "This is the same kernel the server and web app use.",
      "",
    ].join("\n"),
  );
}

/* --------------------------------------------------- repo root + .env loader */

/** Walk up until the workspace marker, mirroring the server's resolution. */
function findRepoRoot(start: string = HERE): string {
  let dir = path.resolve(start);
  while (true) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/** Minimal `.env` parser (no dependency); only fills keys absent from env. */
function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7) : line;
    const eq = body.indexOf("=");
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    if (!key) continue;
    let value = body.slice(eq + 1).trim();
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

function parsePermissionMode(raw: string | undefined): PermissionMode {
  if (raw === "yolo" || raw === "standard" || raw === "readonly") return raw;
  return "yolo";
}

/* --------------------------------------------------------------- rendering */

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`;
}

function cachedTokens(usage: Usage): number {
  return usage.prompt_tokens_details?.cached_tokens ?? 0;
}

function preview(value: unknown, max = 100): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? {});
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

interface Totals {
  calls: number;
  prompt: number;
  completion: number;
  cached: number;
  cost: number;
}

/** Stream one turn's events to the terminal and print a usage/cost total. */
async function runTurn(agent: Agent, input: string): Promise<void> {
  const totals: Totals = {
    calls: 0,
    prompt: 0,
    completion: 0,
    cached: 0,
    cost: 0,
  };
  let streamed = false;
  const controller = new AbortController();

  for await (const event of agent.run(input, controller.signal)) {
    switch (event.type) {
      case "text.delta":
        process.stdout.write(event.text);
        streamed = true;
        break;
      case "assistant.message": {
        if (event.message.role !== "assistant") break;
        if (streamed) {
          process.stdout.write("\n");
        } else if (event.message.content) {
          // The kernel may deliver the answer as a whole message rather than
          // streamed deltas; render it so nothing is lost.
          process.stdout.write(`${event.message.content}\n`);
        } else if ((event.message.tool_calls?.length ?? 0) > 0) {
          process.stdout.write(
            `(tool calls: ${event.message.tool_calls!.length})\n`,
          );
        }
        streamed = false;
        break;
      }
      case "tool.call":
        process.stdout.write(
          `\n[tool] ${event.name} ${preview(event.input)}\n`,
        );
        break;
      case "tool.result":
        process.stdout.write(
          `[tool] ${event.name} ${event.isError ? "ERROR" : "ok"} ${event.durationMs}ms · ${preview(event.output)}\n`,
        );
        break;
      case "mechanism":
        if (event.name === "diff") {
          const data = (event.data ?? {}) as {
            path?: unknown;
            added?: unknown;
            removed?: unknown;
          };
          process.stdout.write(
            `[diff] ${typeof data.path === "string" ? data.path : "?"} +${Number(data.added ?? 0)} -${Number(data.removed ?? 0)}\n`,
          );
        }
        break;
      case "usage": {
        totals.calls += 1;
        totals.prompt += event.usage.prompt_tokens ?? 0;
        totals.completion += event.usage.completion_tokens ?? 0;
        totals.cached += cachedTokens(event.usage);
        totals.cost += event.usage.cost ?? 0;
        process.stdout.write(
          `[usage] prompt ${event.usage.prompt_tokens ?? 0} · completion ${event.usage.completion_tokens ?? 0}` +
            ` · cached ${cachedTokens(event.usage)} · ${formatCost(event.usage.cost ?? 0)}\n`,
        );
        break;
      }
      case "turn.end":
        process.stdout.write(
          `[turn.end] ${event.reason}${event.error ? `: ${event.error}` : ""}\n`,
        );
        break;
      default:
        break;
    }
  }

  process.stdout.write(
    `[total] ${totals.calls} call(s) · prompt ${totals.prompt} · completion ${totals.completion}` +
      ` · cached ${totals.cached} · cost ${formatCost(totals.cost)}\n`,
  );
}

/* --------------------------------------------------------------- CLI entry */

function writeLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function repl(agent: Agent, model: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "agent-things> ",
  });
  writeLine(`REPL (${model}) — type a prompt, "exit"/"quit" or Ctrl+C to leave.`);
  rl.prompt();
  for await (const line of rl) {
    const text = line.trim();
    if (text === "exit" || text === "quit") break;
    if (text.length > 0) await runTurn(agent, text);
    rl.prompt();
  }
  rl.close();
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n\n`);
    printUsage(process.stderr);
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    printUsage(process.stdout);
    return;
  }

  const repoRoot = findRepoRoot();
  loadDotEnv(path.join(repoRoot, ".env"));

  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    process.stderr.write(
      "OPENROUTER_API_KEY is missing. Add it to the repo-root .env or export it.\n",
    );
    process.exitCode = 1;
    return;
  }

  const model =
    opts.model ?? process.env["OPENROUTER_MODEL"] ?? "anthropic/claude-sonnet-4.5";
  const permissionMode =
    opts.permissionMode ?? parsePermissionMode(process.env["PERMISSION_MODE"]);
  const cwd = path.resolve(opts.cwd ?? process.cwd());

  const client = new OpenRouterClient({
    apiKey,
    referer: process.env["OPENROUTER_REFERER"],
    title: process.env["OPENROUTER_TITLE"],
  });
  const tools = new ToolRegistry();
  for (const tool of builtinTools()) tools.register(tool);

  const agent = new Agent(
    { client, model, tools, cwd, permissionMode },
    "cli",
  );

  const oneShot = opts.message ?? (opts.positional.join(" ").trim() || undefined);

  writeLine(`agent-things · model=${model} · cwd=${cwd} · mode=${permissionMode}`);
  if (oneShot) {
    writeLine(`> ${oneShot}`);
    await runTurn(agent, oneShot);
    return;
  }
  await repl(agent, model);
}

main().catch((err) => {
  process.stderr.write(
    `fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
