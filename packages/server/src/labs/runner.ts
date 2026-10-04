/**
 * L3 — Labs runner.
 *
 * Spawns one allowlisted experiment script as a child process and turns its
 * output into a stream of {@link LabFrame}s. The runner owns every guard the
 * brief requires:
 *
 * - the target is resolved from the registry (never a caller path);
 * - the child inherits `process.env`, so the repo-root `.env` (loaded into the
 *   server's environment at boot) is available to API labs;
 * - `LAB_TIMEOUT_MS` kills the whole process **tree** and emits a timeout exit;
 * - the caller can abort (client disconnect) to kill the tree;
 * - only one lab may run at a time — a second `start` throws {@link LabBusyError}.
 *
 * The spawn command is chosen for portability: `tsx` is invoked through `node`
 * on the resolved JS entry (`tsx/dist/cli.mjs`), so Windows `.cmd` shims are
 * never involved. `node` itself is `process.execPath`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { findLab } from "./registry.js";
import type { LabFrame } from "./types.js";

/** Thrown when a run is requested while another lab is already running. */
export class LabBusyError extends Error {
  constructor() {
    super("a lab is already running");
    this.name = "LabBusyError";
  }
}

/** Thrown when the id does not name a catalog entry. */
export class LabNotFoundError extends Error {
  constructor(id: string) {
    super(`unknown lab: ${id}`);
    this.name = "LabNotFoundError";
  }
}

/** How to launch the child: an executable plus its arguments. */
interface LaunchSpec {
  command: string;
  args: string[];
}

/** Resolve the `tsx` CLI entry once; it is a direct dependency of this package. */
function resolveLaunch(repoRoot: string, scriptPath: string): LaunchSpec {
  const require = createRequire(import.meta.url);
  // Resolve the package's own `package.json` (stable across pnpm's symlinked
  // layout, unlike a direct `dist/cli.mjs` subpath which `exports` blocks).
  const cli = resolveTsxCli(require, repoRoot);
  // Run the CLI through the *current* node executable (absolute, no shim).
  return { command: process.execPath, args: [cli, scriptPath] };
}

/** Find `tsx`'s CLI JS entry: package `bin` first, then the conventional path. */
function resolveTsxCli(
  require: NodeJS.Require,
  repoRoot: string,
): string {
  let pkgDir: string | undefined;
  try {
    pkgDir = path.dirname(require.resolve("tsx/package.json"));
  } catch {
    // Fall back to the hoisted layout (a non-pnpm install).
    pkgDir = path.join(repoRoot, "node_modules", "tsx");
  }

  // Prefer the `bin` mapping from the package manifest.
  try {
    const manifest = require(path.join(pkgDir, "package.json")) as {
      bin?: string | Record<string, string>;
    };
    const bin = manifest.bin;
    const entry = typeof bin === "string" ? bin : bin?.["tsx"];
    if (entry) return path.resolve(pkgDir, entry);
  } catch {
    /* fall through */
  }

  // Conventional location inside the published `tsx` package.
  return path.join(pkgDir, "dist", "cli.mjs");
}

/**
 * Kill a child process and every descendant. On Windows `taskkill /T` walks the
 * tree; on POSIX we signal the process group (the child is spawned detached).
 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch {
      // Best effort: fall back to the direct kill below.
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Strip one trailing `\r` so Windows line endings render cleanly. */
function cleanLine(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Incremental line splitter: feed it chunks, get complete lines. Buffers the
 * trailing partial line until the stream ends (then `flush()` emits it).
 */
class LineBuffer {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.map(cleanLine);
  }

  flush(): string[] {
    if (this.buffer === "") return [];
    const line = cleanLine(this.buffer);
    this.buffer = "";
    return [line];
  }
}

/** Options for {@link runLab}. */
export interface RunLabOptions {
  /** Absolute repo root (from `ServerConfig.repoRoot`). */
  repoRoot: string;
  /** Directory the script runs from — the server's cwd (repo root). */
  cwd: string;
  /** Kill the process tree after this many ms (default `300000`). */
  timeoutMs: number;
  /** Kill the process tree when this aborts (client disconnect). */
  signal?: AbortSignal;
}

/**
 * A minimal one-at-a-time gate around the child spawn. `acquire()` reserves the
 * slot (throws {@link LabBusyError} when taken); the returned release callback
 * must be called when the stream ends.
 */
export class LabRunner {
  private running = false;

  /** Whether a lab is currently executing. */
  isBusy(): boolean {
    return this.running;
  }

  /**
   * Reserve the single run slot. Throws {@link LabBusyError} when another lab
   * holds it. Use {@link LabRunner.run} for the common acquire-and-stream path.
   */
  acquire(): () => void {
    if (this.running) throw new LabBusyError();
    this.running = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running = false;
    };
  }

  /**
   * Run the lab named `id` and stream its frames. The returned async generator
   * ends after the terminal `exit` frame. Throws synchronously (before the
   * first frame) for an unknown id or when another lab holds the slot.
   */
  async *run(id: string, opts: RunLabOptions): AsyncGenerator<LabFrame> {
    const lab = findLab(id);
    if (!lab) throw new LabNotFoundError(id);
    const release = this.acquire();
    const scriptPath = path.join(
      opts.repoRoot,
      "packages",
      "server",
      "scripts",
      lab.script,
    );
    try {
      yield* this.stream(id, scriptPath, opts);
    } finally {
      release();
    }
  }

  /**
   * Stream a lab whose slot has **already** been reserved via
   * {@link LabRunner.acquire}. `scriptPath` must be the allowlisted target
   * resolved by the caller; this method never accepts a caller-supplied path
   * on its own — the route resolves it from the registry before calling.
   */
  async *stream(
    id: string,
    scriptPath: string,
    opts: RunLabOptions,
  ): AsyncGenerator<LabFrame> {
    const launch = resolveLaunch(opts.repoRoot, scriptPath);
    yield* this.spawnAndStream(id, launch, opts);
  }

  private async *spawnAndStream(
    id: string,
    launch: LaunchSpec,
    opts: RunLabOptions,
  ): AsyncGenerator<LabFrame> {
    const startedAt = Date.now();
    const child = spawn(launch.command, launch.args, {
      cwd: opts.cwd,
      env: process.env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Single-producer async queue bridged from the child's event callbacks.
    const queue: LabFrame[] = [];
    let notify: (() => void) | null = null;
    let closed = false;
    let timedOut = false;
    let spawnError: string | undefined;

    const push = (frame: LabFrame): void => {
      queue.push(frame);
      notify?.();
      notify = null;
    };

    const stdout = new LineBuffer();
    const stderr = new LineBuffer();
    const emitLines = (frames: string[], toStderr: boolean): void => {
      for (const line of frames) {
        push(toStderr ? { type: "stderr", line } : { type: "stdout", line });
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => emitLines(stdout.push(chunk), false));
    child.stderr?.on("data", (chunk: string) => emitLines(stderr.push(chunk), true));

    child.on("error", (err) => {
      spawnError = err.message;
      // `close` normally follows; if not, unblock the queue anyway.
      if (!closed) {
        closed = true;
        push({ type: "exit", code: null, durationMs: 0, error: spawnError });
        notify?.();
        notify = null;
      }
    });

    child.on("close", (code) => {
      emitLines(stdout.flush(), false);
      emitLines(stderr.flush(), true);
      if (closed) return;
      closed = true;
      push({
        type: "exit",
        code,
        durationMs: Date.now() - startedAt,
        ...(timedOut ? { timedOut: true } : {}),
        ...(spawnError ? { error: spawnError } : {}),
      });
      notify?.();
      notify = null;
    });

    let killed = false;
    const killOnce = (): void => {
      if (killed) return;
      killed = true;
      killTree(child);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killOnce();
    }, opts.timeoutMs);

    const onAbort = (): void => killOnce();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) killOnce();

    yield { type: "start", id, command: [launch.command, ...launch.args].join(" ") };

    try {
      while (!closed || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
          continue;
        }
        const frame = queue.shift();
        if (frame) yield frame;
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      // The client may disconnect mid-stream: make sure the tree is gone.
      if (!killed) killOnce();
    }
  }
}
