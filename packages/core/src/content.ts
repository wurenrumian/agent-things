import type { ChatMessage, Content, ContentPart } from "./types.js";

/**
 * Small helpers for assembling context and for marking cache breakpoints.
 */

/**
 * Turn a string (or parts) into parts so we can attach `cache_control`.
 * OpenRouter passes `cache_control` through to providers that support it.
 */
export function asParts(content: Content): ContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

/** Mark the *end* of a stable prefix as a cache breakpoint. */
export function withCacheBreakpoint(content: Content): ContentPart[] {
  const parts = asParts(content).map((p) => ({ ...p }));
  const last = parts[parts.length - 1];
  if (last) last.cache_control = { type: "ephemeral" };
  return parts;
}

/** Flatten a message's content to plain text (for display + token estimates). */
export function contentToText(content: Content): string {
  if (typeof content === "string") return content;
  return content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

export function messageText(m: ChatMessage): string {
  return contentToText(m.content as Content);
}

/**
 * Coarse token estimate. We cannot count tokens for arbitrary models from the
 * client; this is a *display* heuristic. Real numbers come from `usage`.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
