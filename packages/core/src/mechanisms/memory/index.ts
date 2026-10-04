/**
 * M9 — Memory (mechanism entry point).
 *
 * ## The lesson in one sentence
 *
 * *Memory is just context injected at the right time — and the injection point
 * decides whether it breaks the prompt cache.*
 *
 * A memory has two halves:
 *
 * 1. **Durable state** — `MemoryStore` appends facts to an NDJSON log. This
 *    half is invisible to the model.
 * 2. **Injection** — when a fact is needed, it must become characters in the
 *    message array. That can happen at the **tail** (`memory` tool result, or
 *    `memoryTailMessage`) or in the **system prefix** (`memorySystemSuffix`).
 *    Tail injection preserves the provider's cached prefix; rewriting the
 *    prefix collapses it (M1/M2, and `docs/runs/m9-memory.md` for the M9
 *    measurement).
 *
 * ## Public API (what the INT-* integration wave should wire)
 *
 * ```ts
 * import {
 *   MemoryStore, createMemoryTool, recall, renderMemories,
 *   memorySystemSuffix, memoryTailMessage,
 *   MEMORY_TOOL_NAME, MEMORY_FILE,
 * } from "../../core/src/mechanisms/memory/index.js";
 *
 * // 1. Open the durable store once at startup (dir is configurable).
 * const store = await MemoryStore.open(dataDir + "/memory");
 *
 * // 2. Register exactly one tool. Its result enters the model's context at the
 * //    tail, so recalling a memory never rewrites the system prompt.
 * registry.register(createMemoryTool(store));
 *
 * // 3. Optional: put a *fixed* memory block at the very END of the system
 * //    prompt. Only do this for content that never changes (append-only).
 * const system = baseSystem + memorySystemSuffix(store.all());
 *
 * // 4. Optional: fetch top-K deterministically without a model call.
 * const hits = recall(query, { store, limit: 3 });
 * ```
 *
 * ## Files
 *
 * - `store.ts`  — `MemoryStore`, `MemoryEntry`, append-only NDJSON persistence.
 * - `recall.ts` — deterministic keyword-overlap + recency ranking, `recall()`.
 * - `render.ts` — `renderMemories` + system-suffix / tail-message helpers.
 * - `tool.ts`   — `createMemoryTool`, the `memory` ToolDef.
 *
 * Self-contained: no dependency beyond `node:*`, no edits to shared core files.
 */

export * from "./store.js";
export * from "./recall.js";
export * from "./render.js";
export * from "./tool.js";
