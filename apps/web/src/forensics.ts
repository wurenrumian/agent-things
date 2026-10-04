/**
 * Web-side cache-forensics classifier.
 *
 * The web app talks HTTP only and must not import `@agent/core` (see
 * `types.ts`), so this mirrors `packages/core/src/context-diff.ts` against the
 * local serde types. The two implementations must stay shape-identical: the
 * experiment (`packages/server/scripts/forensics-experiment.ts`) proves the core
 * version, and `docs/mechanisms/forensics.md` records the invariant. Keeping the
 * same semantics here means the view points at exactly the block the run docs
 * describe.
 */

import type {
  AgentEvent,
  ChatMessage,
  ChatRequest,
  Content,
  RequestEvent,
  ToolSchema,
} from "./types";

export type ContextBlock = "none" | "system" | "tools" | "messages";

export interface SystemDiff {
  same: boolean;
  changedAt?: number;
  prevLen: number;
  nextLen: number;
}

export interface ToolDiff {
  same: boolean;
  added: string[];
  removed: string[];
  reordered: boolean;
  firstDiffIndex?: number;
}

export interface MessageDiff {
  prefixLen: number;
  appended: number;
  changedAt?: number;
}

export interface RequestDiff {
  divergence: ContextBlock;
  firstDivergentBlock: ContextBlock;
  system: SystemDiff;
  tools: ToolDiff;
  messages: MessageDiff;
}

/* ------------------------------------------------------------------ helpers */

function contentText(content: Content | null | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content.map((part) => part.text).join("");
}

function flattenSystem(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") parts.push(contentText(message.content));
  }
  return parts.join("\n\n");
}

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
      if ((left.content ?? "") !== (right.content ?? "")) return false;
      const lc = left.tool_calls ?? [];
      const rc = right.tool_calls ?? [];
      if (lc.length !== rc.length) return false;
      for (let k = 0; k < lc.length; k++) {
        const x = lc[k]!;
        const y = rc[k]!;
        if (
          x.id !== y.id ||
          x.function.name !== y.function.name ||
          x.function.arguments !== y.function.arguments
        ) {
          return false;
        }
      }
    } else if (left.role === "tool" && right.role === "tool") {
      if (
        left.tool_call_id !== right.tool_call_id ||
        left.content !== right.content
      ) {
        return false;
      }
    } else if (turnSlotText(left) !== turnSlotText(right)) {
      return false;
    }
  }
  return true;
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

  const pureAppend =
    prefixLen === prevSlots.length && nextSlots.length >= prevSlots.length;

  if (pureAppend) return { prefixLen, appended: nextSlots.length - prefixLen };

  return {
    prefixLen,
    appended: 0,
    ...(prefixLen >= prevSlots.length && prefixLen >= nextSlots.length
      ? {}
      : { changedAt: prefixLen }),
  };
}

export function diffRequests(prev: ChatRequest, next: ChatRequest): RequestDiff {
  const system = diffSystem(prev, next);
  const tools = diffTools(prev, next);
  const messages = diffMessages(prev, next);

  let divergence: ContextBlock;
  if (!system.same) divergence = "system";
  else if (!tools.same) divergence = "tools";
  else if (messages.changedAt !== undefined) divergence = "messages";
  else divergence = "none";

  return {
    divergence,
    firstDivergentBlock: divergence,
    system,
    tools,
    messages,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/* ------------------------------------------------------- pairing + usage */

/**
 * One consecutive-request pair plus the classification and the cache numbers
 * before/after. `usage.cached_tokens` is matched to a request by the *next*
 * `usage` event after it, which is how the loop emits them.
 */
export interface ForensicsPair {
  index: number;
  at: number;
  prevAt: number;
  model: string;
  diff: RequestDiff;
  cachedBefore: number | null;
  cachedAfter: number | null;
  promptAfter: number | null;
}

export interface ForensicsView {
  pairs: ForensicsPair[];
  requestCount: number;
}

/** Pair consecutive `request.sent` events and attach before/after cache hits. */
export function collectForensics(events: AgentEvent[]): ForensicsView {
  const requests: RequestEvent[] = [];
  const requestIndices: number[] = [];
  events.forEach((event, index) => {
    if (event.type === "request.sent") {
      requests.push(event);
      requestIndices.push(index);
    }
  });

  // `usage` is emitted for the request that immediately precedes it.
  const cachedByRequest = new Map<number, number>();
  const promptByRequest = new Map<number, number>();
  events.forEach((event, i) => {
    if (event.type !== "usage") return;
    let reqIndex = -1;
    for (let k = i - 1; k >= 0; k--) {
      if (events[k]!.type === "request.sent") {
        reqIndex = k;
        break;
      }
    }
    if (reqIndex === -1) return;
    cachedByRequest.set(
      reqIndex,
      event.usage.prompt_tokens_details?.cached_tokens ?? 0,
    );
    promptByRequest.set(reqIndex, event.usage.prompt_tokens ?? 0);
  });

  const pairs: ForensicsPair[] = [];
  for (let i = 1; i < requests.length; i++) {
    const prev = requests[i - 1]!;
    const next = requests[i]!;
    const prevGlobalIndex = requestIndices[i - 1]!;
    const nextGlobalIndex = requestIndices[i]!;
    pairs.push({
      index: i,
      at: next.at,
      prevAt: prev.at,
      model: next.model,
      diff: diffRequests(prev.body, next.body),
      cachedBefore: cachedByRequest.get(prevGlobalIndex) ?? null,
      cachedAfter: cachedByRequest.get(nextGlobalIndex) ?? null,
      promptAfter: promptByRequest.get(nextGlobalIndex) ?? null,
    });
  }

  return { pairs, requestCount: requests.length };
}
