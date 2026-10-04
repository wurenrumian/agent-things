/**
 * Pure, dependency-free context diff — "who broke the cache?".
 *
 * Provider prompt caching is a **byte prefix** of the serialized request. The
 * cacheable layout is, in order:
 *
 *     [ system ]  ->  [ tools ]  ->  [ messages ]
 *
 * A hit survives exactly up to the **first divergent block**. Because the
 * provider serializes system first, then the order-sensitive `tools` array,
 * then the message array, a change *later* in that order cannot invalidate an
 * *earlier* block — so the first block that differs is the one that decides the
 * damage. This helper classifies that first block from two `ChatRequest`s,
 * independent of any provider call.
 *
 * Semantics mirror the recorded M1/M4 experiments (`docs/runs/m1-cache.md`,
 * `docs/runs/m4-mcp.md`):
 *   - identical requests                -> `none`
 *   - `tools` order reversed/added      -> `tools` (order-sensitive)
 *   - `system` byte changed             -> `system`
 *   - messages only appended            -> `none` (prefix intact)
 *   - a middle message edited           -> `messages` (from that index on)
 *
 * The message block is treated as an ordered list of *turn slots*, not of raw
 * messages: an edit that keeps a slot's byte length but changes its text (e.g.
 * a tool result whose `call_0` becomes `call_1`) still counts as a divergence at
 * that slot. See `docs/mechanisms/forensics.md` for the teaching write-up.
 */

import type {
  AssistantMessage,
  ChatMessage,
  ChatRequest,
  Content,
  ToolMessage,
  ToolSchema,
} from "./types.js";

/** A block in the cacheable prefix, in serialization order. */
export type ContextBlock = "none" | "system" | "tools" | "messages";

export interface SystemDiff {
  same: boolean;
  /** Index of the first differing byte of the flattened system text. */
  changedAt?: number;
  prevLen: number;
  nextLen: number;
}

export interface ToolDiff {
  same: boolean;
  /** Tool names present only in `next`. */
  added: string[];
  /** Tool names present only in `prev`. */
  removed: string[];
  /** Same membership but a different order. */
  reordered: boolean;
  /** Index of the first element that differs (by name or position). */
  firstDiffIndex?: number;
}

export interface MessageDiff {
  /**
   * The length of the leading *turn slots* perfect-prefix-shared by `prev` and
   * `next` — everything from here on is new or rewritten.
   */
  prefixLen: number;
  /** Trailing turns appended verbatim after that shared prefix (>= 0). */
  appended: number;
  /** Index of the first non-append difference, when one exists. */
  changedAt?: number;
}

export interface RequestDiff {
  /** The earliest block whose bytes differ (`none` when append-only). */
  divergence: ContextBlock;
  /** Alias kept for display symmetry with `divergence`. */
  firstDivergentBlock: ContextBlock;
  system: SystemDiff;
  tools: ToolDiff;
  messages: MessageDiff;
}

/* ------------------------------------------------------------------ helpers */

/** Join every `Content` of a message array into one flattened string. */
export function flattenSystem(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") parts.push(contentText(message.content));
  }
  return parts.join("\n\n");
}

function contentText(content: Content | null | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content.map((part) => part.text).join("");
}

function sameContent(a: Content | null, b: Content | null): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return contentText(a) === contentText(b);
}

/** Normalized text of a non-system turn slot, for byte-level comparison. */
function turnSlotText(message: ChatMessage): string {
  switch (message.role) {
    case "user":
      return `user\u0000${contentText(message.content)}`;
    case "assistant": {
      const calls = (message.tool_calls ?? [])
        .map((c) => `${c.id}\u0000${c.function.name}\u0000${c.function.arguments}`)
        .join("\u0001");
      return `assistant\u0000${message.content ?? ""}\u0000${calls}`;
    }
    case "tool":
      return `tool\u0000${message.tool_call_id}\u0000${message.content}`;
    default:
      return `system\u0000${contentText((message as { content: Content }).content)}`;
  }
}

/** Group a message array into turn slots: an assistant + trailing tools is one. */
function splitTurnSlots(messages: ChatMessage[]): ChatMessage[][] {
  const slots: ChatMessage[][] = [];
  let current: ChatMessage[] | null = null;
  for (const message of messages) {
    if (message.role === "assistant") {
      if (current) slots.push(current);
      current = [message];
    } else if (message.role === "tool" && current) {
      current.push(message);
    } else {
      if (current) {
        slots.push(current);
        current = null;
      }
      slots.push([message]);
    }
  }
  if (current) slots.push(current);
  return slots;
}

function sameTurnSlot(a: ChatMessage[], b: ChatMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (left.role !== right.role) return false;
    if (left.role === "assistant" && right.role === "assistant") {
      if (!sameAssistant(left, right)) return false;
    } else if (left.role === "tool" && right.role === "tool") {
      if (!sameToolCall(left, right)) return false;
    } else if (turnSlotText(left) !== turnSlotText(right)) {
      return false;
    }
  }
  return true;
}

function sameAssistant(a: AssistantMessage, b: AssistantMessage): boolean {
  if ((a.content ?? "") !== (b.content ?? "")) return false;
  const ac = a.tool_calls ?? [];
  const bc = b.tool_calls ?? [];
  if (ac.length !== bc.length) return false;
  for (let i = 0; i < ac.length; i++) {
    const x = ac[i]!;
    const y = bc[i]!;
    if (
      x.id !== y.id ||
      x.function.name !== y.function.name ||
      x.function.arguments !== y.function.arguments
    ) {
      return false;
    }
  }
  return true;
}

function sameToolCall(a: ToolMessage, b: ToolMessage): boolean {
  return a.tool_call_id === b.tool_call_id && a.content === b.content;
}

function toolName(schema: ToolSchema | undefined): string {
  return schema?.function?.name ?? "";
}

/* ------------------------------------------------------------ block diffs */

function diffSystem(prev: ChatRequest, next: ChatRequest): SystemDiff {
  const prevText = flattenSystem(prev.messages);
  const nextText = flattenSystem(next.messages);
  if (prevText === nextText) {
    return { same: true, prevLen: prevText.length, nextLen: nextText.length };
  }
  const limit = Math.min(prevText.length, nextText.length);
  let i = 0;
  while (i < limit && prevText[i] === nextText[i]) i++;
  return {
    same: false,
    changedAt: i,
    prevLen: prevText.length,
    nextLen: nextText.length,
  };
}

function diffTools(prev: ChatRequest, next: ChatRequest): ToolDiff {
  const before = prev.tools ?? [];
  const after = next.tools ?? [];
  const beforeNames = before.map(toolName);
  const afterNames = after.map(toolName);

  const beforeSet = new Set(beforeNames);
  const afterSet = new Set(afterNames);
  const added = afterNames.filter((name) => !beforeSet.has(name));
  const removed = beforeNames.filter((name) => !afterSet.has(name));

  let firstDiffIndex: number | undefined;
  const limit = Math.min(before.length, after.length);
  for (let i = 0; i < limit; i++) {
    if (stableStringify(before[i]) !== stableStringify(after[i])) {
      firstDiffIndex = i;
      break;
    }
  }
  if (firstDiffIndex === undefined && before.length !== after.length) {
    firstDiffIndex = limit;
  }

  const membershipSame = added.length === 0 && removed.length === 0;
  const reordered =
    membershipSame && firstDiffIndex !== undefined && firstDiffIndex < beforeNames.length;

  return {
    same: firstDiffIndex === undefined,
    added,
    removed,
    reordered,
    ...(firstDiffIndex === undefined ? {} : { firstDiffIndex }),
  };
}

function diffMessages(prev: ChatRequest, next: ChatRequest): MessageDiff {
  const prevSlots = splitTurnSlots(prev.messages);
  const nextSlots = splitTurnSlots(next.messages);

  let prefixLen = 0;
  const limit = Math.min(prevSlots.length, nextSlots.length);
  while (
    prefixLen < limit &&
    sameTurnSlot(prevSlots[prefixLen]!, nextSlots[prefixLen]!)
  ) {
    prefixLen++;
  }

  // A pure append means every slot of `prev` is also a slot of `next`, in order,
  // and the extra slots all live at the tail.
  const pureAppend =
    prefixLen === prevSlots.length && nextSlots.length >= prevSlots.length;

  if (pureAppend) return { prefixLen, appended: nextSlots.length - prefixLen };

  // Same length, nothing shared, but content differs at index `prefixLen`:
  // still a rewrite, just with no trailing tail. `appended` stays 0.
  return {
    prefixLen,
    appended: 0,
    ...(prefixLen >= prevSlots.length && prefixLen >= nextSlots.length
      ? {}
      : { changedAt: prefixLen }),
  };
}

/* ------------------------------------------------------------------- main */

/**
 * Classify the first divergent block between two consecutive requests.
 *
 * Deterministic and pure: no clock, no I/O, no provider. Safe to call from the
 * server, the CLI, or the web (the web re-implements it against its serde
 * mirror — see `docs/mechanisms/forensics.md` §4 for why the shapes must match).
 */
export function diffRequests(prev: ChatRequest, next: ChatRequest): RequestDiff {
  const system = diffSystem(prev, next);
  const tools = diffTools(prev, next);
  const messages = diffMessages(prev, next);

  let divergence: ContextBlock;
  if (!system.same) {
    divergence = "system";
  } else if (!tools.same) {
    divergence = "tools";
  } else if (messages.changedAt !== undefined) {
    divergence = "messages";
  } else {
    divergence = "none";
  }

  return {
    divergence,
    firstDivergentBlock: divergence,
    system,
    tools,
    messages,
  };
}

/** Deterministic JSON (keys sorted) so tool-schema comparison is order-stable. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
