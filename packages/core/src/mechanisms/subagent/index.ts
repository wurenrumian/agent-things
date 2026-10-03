/**
 * M5 — subagent & context isolation.
 *
 * The idea in one sentence: a subagent is a *fresh* `Agent` with its own
 * message array and its own system prompt, so the noisy intermediate output of
 * an investigation lands in the child's context and never in the parent's. The
 * parent pays only for the child's final answer.
 *
 * This module is self-contained (mechanisms/ 铁律 #1): it adds files only under
 * `mechanisms/subagent/`, imports the kernel through relative paths, and adds no
 * dependency. It wires into the loop the same way every mechanism does — by
 * returning a `ToolDef` the coordinator can register.
 *
 * Recursion guard: the child's toolset is the builtin tools **minus** `task`, so
 * a subagent cannot spawn another subagent. This also keeps the child's tool
 * schema prefix stable and small.
 */

import { Agent } from "../../agent/loop.js";
import type { PermissionMode } from "../../permissions.js";
import type { OpenRouterClient } from "../../provider/openrouter.js";
import { builtinTools } from "../../tools/builtin.js";
import { ToolRegistry, type ToolDef } from "../../tools/registry.js";
import type { JSONSchema, Usage } from "../../types.js";

/** The tool name the parent calls to delegate work. */
export const TASK_TOOL_NAME = "task";

/**
 * The child's *own* system prompt. It is deliberately different from the main
 * agent's: a subagent is not a conversational partner, it is a bounded worker
 * whose only output back to the parent is one final message. Telling it that
 * explicitly is what keeps the returned summary short and on-task.
 */
export const SUBAGENT_SYSTEM_PROMPT = `You are a focused subagent invoked by a parent coding agent through the "task" tool.

You operate in complete isolation: you cannot see the parent's conversation, and
the parent cannot see yours. The parent will receive ONLY your final reply —
everything else (tool calls and their raw output) is discarded. Therefore:

- Work autonomously and iterate until the task is done; do not ask questions.
- Investigate with the tools you have before you conclude.
- End with your answer as plain text, not a tool call.
- Be concise and information-dense. Every byte you return costs the parent
  context; do not paste raw file dumps or tool output into your final answer.`;

/** Aggregated token/cost numbers over a set of provider calls. */
export interface SubagentUsageSummary {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  cost: number;
}

/** Everything one subagent run produced, including the raw `usage` records. */
export interface SubagentRun {
  /** The final assistant text — the only thing handed back to the parent. */
  text: string;
  /** Raw usage, one entry per provider call the child made. */
  usages: Usage[];
  /** Aggregated totals over `usages`. */
  summary: SubagentUsageSummary;
  /** Child session id (its own, for provider sticky-routing / caching). */
  sessionId: string;
  /** Number of assistant messages the child produced. */
  steps: number;
  /** Number of tool calls the child executed. */
  toolCalls: number;
  /** Set when the child's turn ended with `reason: "error"`. */
  error?: string;
}

export interface RunSubagentOptions {
  client: OpenRouterClient;
  model: string;
  /** The self-contained task for the child. */
  prompt: string;
  /** Working directory the child operates in (path tools stay inside it). */
  cwd: string;
  /** Permission mode inherited from the parent. Defaults to `yolo`. */
  permissionMode?: PermissionMode;
  maxSteps?: number;
  temperature?: number;
  platform?: string;
  /** Extra tools for the child; builtins are always included, `task` removed. */
  extraTools?: ToolDef[];
  /** Override the child system prompt (defaults to {@link SUBAGENT_SYSTEM_PROMPT}). */
  systemPrompt?: string;
  signal?: AbortSignal;
  /** Override the child session id (defaults to a fresh one per run). */
  sessionId?: string;
}

/** Sum a list of provider `usage` records into one row. Exported for the ledger. */
export function summarizeUsage(usages: Usage[]): SubagentUsageSummary {
  const out: SubagentUsageSummary = {
    calls: usages.length,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    cost: 0,
  };
  for (const u of usages) {
    const prompt = u.prompt_tokens ?? 0;
    const completion = u.completion_tokens ?? 0;
    out.promptTokens += prompt;
    out.completionTokens += completion;
    out.totalTokens += u.total_tokens ?? prompt + completion;
    out.cachedTokens += u.prompt_tokens_details?.cached_tokens ?? 0;
    out.cost += u.cost ?? 0;
  }
  return out;
}

/**
 * The child's toolset: the builtin tools minus `task` (recursion guard), plus
 * any extras, with `task` stripped from those too. Order does not matter here —
 * `ToolRegistry.list()` re-sorts by name, which is what keeps the tool-schema
 * prefix cache-stable.
 */
export function subagentTools(extra: ToolDef[] = []): ToolDef[] {
  return [...builtinTools(), ...extra].filter((t) => t.name !== TASK_TOOL_NAME);
}

/** Monotonic counter so two runs in the same millisecond still get distinct ids. */
let runCounter = 0;

/**
 * Run a self-contained task in a fresh child `Agent` and return only its final
 * assistant text plus the usage ledger. The child owns its message array and
 * system prompt; nothing it does leaks into the caller's context.
 */
export async function runSubagent(opts: RunSubagentOptions): Promise<SubagentRun> {
  const registry = new ToolRegistry();
  for (const tool of subagentTools(opts.extraTools)) registry.register(tool);

  const sessionId =
    opts.sessionId ?? `subagent-${Date.now().toString(36)}-${++runCounter}`;
  const agent = new Agent(
    {
      client: opts.client,
      model: opts.model,
      tools: registry,
      cwd: opts.cwd,
      permissionMode: opts.permissionMode ?? "yolo",
      maxSteps: opts.maxSteps ?? 16,
      temperature: opts.temperature,
      platform: opts.platform,
      systemPromptOverride: opts.systemPrompt ?? SUBAGENT_SYSTEM_PROMPT,
    },
    sessionId,
  );

  const usages: Usage[] = [];
  let finalText = "";
  let steps = 0;
  let toolCalls = 0;
  let error: string | undefined;

  for await (const event of agent.run(opts.prompt, opts.signal)) {
    switch (event.type) {
      case "assistant.message": {
        steps += 1;
        const message = event.message;
        // The loop returns once an assistant message carries no tool calls, so
        // the last non-empty assistant text is exactly the child's answer.
        if (
          message.role === "assistant" &&
          typeof message.content === "string" &&
          message.content.trim().length > 0
        ) {
          finalText = message.content;
        }
        break;
      }
      case "tool.call":
        toolCalls += 1;
        break;
      case "usage":
        usages.push(event.usage);
        break;
      case "turn.end":
        if (event.reason === "error") {
          error = event.error ?? "subagent turn ended with error";
        }
        break;
      default:
        break;
    }
  }

  return {
    text: finalText.trim(),
    usages,
    summary: summarizeUsage(usages),
    sessionId,
    steps,
    toolCalls,
    error,
  };
}

export interface TaskToolOptions {
  client: OpenRouterClient;
  model: string;
  /** Parent's permission mode; the child inherits it. Defaults to `yolo`. */
  permissionMode?: PermissionMode;
  maxSteps?: number;
  temperature?: number;
  platform?: string;
  /** Clamp the summary handed back to the parent (characters). Default 4000. */
  maxResultChars?: number;
  /** Observability hook fired after every child run (used by the ledger). */
  onRun?: (info: {
    prompt: string;
    description?: string;
    run: SubagentRun;
  }) => void;
}

const TASK_PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    description: {
      type: "string",
      description: "A short (3–5 word) label for the delegated task.",
    },
    prompt: {
      type: "string",
      description:
        "The complete, self-contained task for the subagent. It cannot see " +
        "your conversation, so include all necessary context and state exactly " +
        "what final output you expect.",
    },
  },
  required: ["prompt"],
};

/**
 * Build the `task` tool. Register it in the parent's `ToolRegistry`; when the
 * model calls it, a fresh subagent runs the prompt to completion and the tool
 * result contains **only** the child's final text.
 */
export function createTaskTool(opts: TaskToolOptions): ToolDef {
  return {
    name: TASK_TOOL_NAME,
    description:
      "Delegate a self-contained task to a fresh subagent with its own isolated " +
      "context. The subagent runs to completion using the built-in tools and " +
      "returns ONLY its final summary; its intermediate tool output never enters " +
      "your context. Use it for investigations that would otherwise flood your " +
      "context with output you do not need to keep.",
    readOnly: true,
    parameters: TASK_PARAMETERS,
    async execute(input, ctx) {
      const prompt =
        typeof input["prompt"] === "string" ? input["prompt"].trim() : "";
      const description =
        typeof input["description"] === "string" ? input["description"] : undefined;
      if (!prompt) {
        return {
          output: "Error: `prompt` is required and must be a non-empty string.",
          isError: true,
        };
      }

      const run = await runSubagent({
        client: opts.client,
        model: opts.model,
        prompt,
        cwd: ctx.cwd,
        permissionMode: opts.permissionMode,
        maxSteps: opts.maxSteps,
        temperature: opts.temperature,
        platform: opts.platform,
        signal: ctx.signal,
      });
      opts.onRun?.({ prompt, description, run });

      if (run.error && run.text.length === 0) {
        return { output: `Subagent failed: ${run.error}`, isError: true };
      }
      const text =
        run.text.length > 0 ? run.text : "(subagent produced no final text)";
      const max = opts.maxResultChars ?? 4000;
      return {
        output: text.length > max ? `${text.slice(0, max)}…[truncated]` : text,
      };
    },
  };
}
