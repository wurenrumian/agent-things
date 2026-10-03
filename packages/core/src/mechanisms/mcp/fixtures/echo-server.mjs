#!/usr/bin/env node
/**
 * Fixture MCP server (stdio, newline-delimited JSON-RPC 2.0).
 *
 * Hand-written on purpose: it lets the M4 experiment prove a *real* JSON-RPC
 * round-trip against a real child process without pulling in the MCP SDK.
 *
 * It exposes `MCP_FIXTURE_TOOLS` echo tools (default 2). The count is what makes
 * the token-cost measurement genuine: the client really fetches N tools over
 * `tools/list` rather than fabricating schemas locally.
 *
 *   MCP_FIXTURE_TOOLS=20 node fixtures/echo-server.mjs
 */

import { stdin, stdout } from "node:process";

const count = Math.max(1, Number(process.env.MCP_FIXTURE_TOOLS ?? "2") || 2);

/** @type {Array<{name:string,description:string,inputSchema:Record<string,unknown>}>} */
const tools = [];
for (let i = 1; i <= count; i++) {
  tools.push({
    name: `echo_${i}`,
    description:
      `Echo back a short text payload (fixture MCP tool #${i}). ` +
      `Use it to verify JSON-RPC round-trips and to measure the per-tool ` +
      `schema token cost when many MCP tools are injected eagerly.`,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to echo back verbatim." },
        uppercase: {
          type: "boolean",
          description: "When true, upper-case the echoed text.",
        },
        repeat: {
          type: "integer",
          description: "How many times to repeat the echoed text (default 1).",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  });
}

function send(message) {
  stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(message) {
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  try {
    if (method === "initialize") {
      if (!isNotification) {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: params?.protocolVersion ?? "2024-11-05",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "m4-echo-fixture", version: "0.0.0" },
          },
        });
      }
      return;
    }
    if (method === "notifications/initialized") {
      return;
    }
    if (method === "tools/list") {
      if (!isNotification) {
        send({ jsonrpc: "2.0", id, result: { tools } });
      }
      return;
    }
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        if (!isNotification) {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `unknown tool: ${String(name)}` },
          });
        }
        return;
      }
      const text = String(args.text ?? "");
      const body = args.uppercase === true ? text.toUpperCase() : text;
      const repeat = Math.max(1, Number(args.repeat) || 1);
      if (!isNotification) {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              { type: "text", text: `echo(${name}): ${body.repeat(repeat)}` },
            ],
            isError: false,
          },
        });
      }
      return;
    }
    if (method === "ping") {
      if (!isNotification) send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (!isNotification) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `method not found: ${String(method)}` },
      });
    }
  } catch (err) {
    if (!isNotification) {
      send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
}

let buffer = "";
stdin.setEncoding("utf8");
stdin.on("data", (chunk) => {
  buffer += chunk;
  let sep;
  while ((sep = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, sep).trim();
    buffer = buffer.slice(sep + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // Ignore malformed lines; the client owns framing.
    }
  }
});
