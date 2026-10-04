/**
 * M10 — `createOrchestratorTools(supervisor)`.
 *
 * The five `ToolDef`s a parent `Agent` registers to drive the supervisor,
 * mirroring Orca's orchestrator vocabulary:
 *
 *  - `spawn_worker` — start a fresh isolated worker (non-blocking).
 *  - `wait_for`     — block until a mailbox message for the coordinator arrives
 *                     (optionally a specific worker / type), then ack it.
 *  - `send_message` — send a `question` / `reply` / `escalation` / `note`.
 *  - `list_workers` — snapshot the registry.
 *  - `stop_worker`  — abort one worker.
 *
 * None of these edits the kernel: they are ordinary `ToolDef`s, so the loop
 * already knows how to call them. Mechanism progress rides back through the
 * tool output (a one-line summary), never through terminal scraping.
 */

import type { JSONSchema } from "../../types.js";
import type { ToolDef } from "../../tools/registry.js";
import type { MailboxFilter } from "./mailbox.js";
import type { MailboxMessage, MailboxMessageType } from "./types.js";
import type { Supervisor } from "./supervisor.js";

const MESSAGE_TYPES: MailboxMessageType[] = [
  "question",
  "reply",
  "escalation",
  "worker_done",
  "note",
];

function isMessageType(value: unknown): value is MailboxMessageType {
  return typeof value === "string" && (MESSAGE_TYPES as string[]).includes(value);
}

function stringArg(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function numberArg(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function preview(text: string, max = 120): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`;
}

function formatMessage(message: MailboxMessage, acked: boolean): string {
  const lines = [
    `id=${message.id} type=${message.type} from=${message.from} to=${message.to} at=${message.at} acked=${acked}`,
  ];
  if (message.subject) lines.push(`subject: ${message.subject}`);
  lines.push("body:", message.body);
  return lines.join("\n");
}

/** Build the coordinator-facing toolset for one supervisor. */
export function createOrchestratorTools(supervisor: Supervisor): ToolDef[] {
  const coordinatorId = supervisor.coordinatorId;

  const spawnWorker: ToolDef = {
    name: "spawn_worker",
    description:
      "Spawn a worker with its own isolated context to run one self-contained " +
      "task in parallel. Returns immediately with the worker id; the worker's " +
      "final summary arrives as a `worker_done` message (use `wait_for`). " +
      "Include ALL context the worker needs in `task`: it cannot see your " +
      "conversation.",
    readOnly: false,
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "A short (3–5 word) label for the worker.",
        },
        task: {
          type: "string",
          description:
            "The complete, self-contained task. State exactly what final " +
            "output you expect.",
        },
        system_prompt: {
          type: "string",
          description: "Optional system-prompt override for this worker.",
        },
      },
      required: ["name", "task"],
    },
    async execute(input) {
      const name = stringArg(input, "name");
      const task = stringArg(input, "task");
      if (!name || !task) {
        return {
          output: "Error: `name` and `task` are required non-empty strings.",
          isError: true,
        };
      }
      const systemPrompt = stringArg(input, "system_prompt");
      const record = supervisor.spawn(
        systemPrompt ? { name, task, systemPrompt } : { name, task },
      );
      return {
        output:
          `spawned worker ${record.id} ("${record.name}"), status=${record.status}. ` +
          `It runs in parallel; collect its final summary with ` +
          `wait_for(types=["worker_done"], from="${record.id}").`,
      };
    },
  };

  const waitFor: ToolDef = {
    name: "wait_for",
    description:
      "Block until a mailbox message addressed to the coordinator matches the " +
      "given types / sender, then return it (and ack it unless ack=false). Use " +
      "it instead of polling: an unacked message is replayed automatically.",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        types: {
          type: "array",
          items: { type: "string", enum: MESSAGE_TYPES },
          description:
            "Message types to wait for (default: any). Common: worker_done, question, escalation.",
        },
        from: {
          type: "string",
          description: "Only accept messages from this worker id.",
        },
        timeout_ms: {
          type: "integer",
          description: "Maximum time to block (default 30000; 0 = check once).",
        },
        ack: {
          type: "boolean",
          description:
            "Ack the delivered message (default true). Set false to demonstrate replay.",
        },
      },
    },
    async execute(input) {
      const rawTypes = Array.isArray(input["types"]) ? input["types"] : [];
      const types = rawTypes.filter(isMessageType);
      const from = stringArg(input, "from");
      const timeout = numberArg(input, "timeout_ms") ?? 30_000;
      const ack = input["ack"] === undefined ? true : input["ack"] !== false;

      const filter: MailboxFilter = { to: coordinatorId };
      if (from) filter.from = from;

      const message = await supervisor.waitFor(
        types.length > 0 ? types : undefined,
        timeout,
        filter,
      );
      if (!message) {
        return {
          output: `(no matching message within ${timeout}ms; use list_workers to inspect state)`,
        };
      }
      const acked = ack ? supervisor.mailbox.ack(message.id) : false;
      return { output: formatMessage(message, acked && ack) };
    },
  };

  const sendMessage: ToolDef = {
    name: "send_message",
    description:
      "Send a message from the coordinator to a worker (or broadcast with " +
      "to=\"*\"). Use type=reply to answer a worker's question, escalation for " +
      "a blocker, note for advisory context.",
    readOnly: false,
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient worker id, or \"*\" to broadcast.",
        },
        type: {
          type: "string",
          enum: MESSAGE_TYPES,
          description: "Message type (question | reply | escalation | worker_done | note).",
        },
        subject: { type: "string", description: "Optional short label." },
        body: { type: "string", description: "The message body." },
      },
      required: ["to", "type", "body"],
    },
    async execute(input) {
      const to = stringArg(input, "to");
      const type = input["type"];
      const body = stringArg(input, "body");
      if (!to || !isMessageType(type) || !body) {
        return {
          output:
            "Error: `to` (string), `type` (valid message type), and `body` " +
            "(non-empty string) are required.",
          isError: true,
        };
      }
      const subject = stringArg(input, "subject");
      const message = supervisor.send(
        subject ? { to, type, body, subject } : { to, type, body },
      );
      return {
        output: `sent ${message.id} → ${message.to} (${message.type})`,
      };
    },
  };

  const listWorkers: ToolDef = {
    name: "list_workers",
    description:
      "List every worker with its status, session id and (when finished) a " +
      "short preview of its final summary. Use it to see who is still running " +
      "or blocked.",
    readOnly: true,
    parameters: { type: "object", properties: {} },
    async execute() {
      const workers = supervisor.registry.snapshot();
      if (workers.length === 0) return { output: "(no workers)" };
      const lines = workers.map((w) => {
        const where = w.sessionId ? `session=${w.sessionId}` : "session=—";
        const previewText = w.result
          ? ` result="${preview(w.result, 60)}"`
          : w.error
            ? ` error="${preview(w.error, 60)}"`
            : "";
        return `${w.id}\t${w.status}\t"${w.name}"\t${where}${previewText}`;
      });
      return { output: lines.join("\n") };
    },
  };

  const stopWorker: ToolDef = {
    name: "stop_worker",
    description:
      "Abort a running worker by id. Returns whether it was still active.",
    readOnly: false,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The worker id to stop." },
      },
      required: ["id"],
    },
    async execute(input) {
      const id = stringArg(input, "id");
      if (!id) return { output: "Error: `id` is required.", isError: true };
      const record = supervisor.registry.get(id);
      if (!record) {
        return { output: `Error: unknown worker "${id}".`, isError: true };
      }
      const stopped = supervisor.stop(id);
      return {
        output: stopped
          ? `stopped worker ${id}`
          : `worker ${id} is already ${record.status}; nothing to stop`,
      };
    },
  };

  return [spawnWorker, waitFor, sendMessage, listWorkers, stopWorker];
}
