import { spawn, type ChildProcess } from "node:child_process";

/**
 * Minimal JSON-RPC 2.0 transport over a child process's stdio.
 *
 * MCP's stdio transport frames messages as **newline-delimited JSON**: one
 * complete JSON-RPC object per line on the child's stdout, and the same on its
 * stdin. No SDK, no length-prefix headers — just read lines and correlate ids.
 *
 * Deliberately tiny: the whole point of this project is to see the bytes that
 * cross the boundary, so we hand-roll rather than hide them behind a library.
 */

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface TransportOptions {
  /** Executable to launch, e.g. `node`. */
  command: string;
  args: string[];
  cwd?: string;
  /** Extra environment variables layered over `process.env`. */
  env?: Record<string, string>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class StdioTransport {
  private readonly child: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderr = "";
  private exited = false;

  constructor(opts: TransportOptions) {
    this.child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const { stdin, stdout, stderr } = this.child;
    if (!stdin || !stdout || !stderr) {
      throw new Error("failed to open MCP child process stdio pipes");
    }

    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => this.onData(chunk));

    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
    });

    this.child.on("error", (err) => this.failAll(this.wrap(err)));
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      if (this.pending.size > 0) {
        this.failAll(
          new Error(
            `MCP server exited (code=${code ?? "null"}, signal=${signal ?? "null"})` +
              (this.stderr.trim() ? `: ${this.stderr.trim()}` : ""),
          ),
        );
      }
    });
  }

  /** Send a request and resolve with its `result`, or reject on a JSON-RPC error. */
  request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const message =
      params === undefined
        ? { jsonrpc: "2.0" as const, id, method }
        : { jsonrpc: "2.0" as const, id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.write(message);
    });
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    const message =
      params === undefined
        ? { jsonrpc: "2.0" as const, method }
        : { jsonrpc: "2.0" as const, method, params };
    this.write(message);
  }

  /** End stdin and kill the child. Safe to call more than once. */
  close(): void {
    if (this.exited) return;
    try {
      this.child.stdin?.end();
    } catch {
      // The pipe may already be gone; nothing to clean up.
    }
    this.exited = true;
    this.child.kill();
    this.failAll(new Error("MCP transport closed"));
  }

  private write(message: unknown): void {
    if (this.exited) throw new Error("MCP transport is closed");
    const stdin = this.child.stdin;
    if (!stdin) throw new Error("MCP transport stdin unavailable");
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let sep: number;
    while ((sep = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, sep).trim();
      this.buffer = this.buffer.slice(sep + 1);
      if (!line) continue;
      this.dispatch(line);
    }
  }

  private dispatch(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      // Ignore non-JSON noise (logs a server might accidentally print).
      return;
    }
    // Notifications have no id (or a null id); there is nothing to correlate.
    if (message.id === undefined || message.id === null) return;
    const id = typeof message.id === "string" ? Number(message.id) : message.id;
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error) {
      pending.reject(
        new Error(`MCP error ${message.error.code}: ${message.error.message}`),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private failAll(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }

  private wrap(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
  }
}
