import type { Content, Usage } from "./types";

/** Flatten a message `content` (string or typed parts) to plain text. */
export function contentToText(content: Content): string {
  if (typeof content === "string") return content;
  return content.map((part) => part.text).join("");
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatCost(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0.0000";
  return `$${n.toFixed(4)}`;
}

export function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", { hour12: false });
}

export function formatDateTime(at: number): string {
  return new Date(at).toLocaleString("en-US", { hour12: false });
}

/** Tokens served from the provider cache on this call. */
export function cachedTokens(u: Usage): number {
  return u.prompt_tokens_details?.cached_tokens ?? 0;
}

/** Tokens written into the cache on this call. */
export function cacheWriteTokens(u: Usage): number {
  return u.prompt_tokens_details?.cache_write_tokens ?? 0;
}

/** Fraction of the prompt served from cache, 0..1. */
export function cacheHitRate(u: Usage): number {
  const prompt = u.prompt_tokens ?? 0;
  if (prompt <= 0) return 0;
  return cachedTokens(u) / prompt;
}

/* --------------------------------------------------------- usage roll-ups */

export interface UsageTotals {
  calls: number;
  prompt: number;
  completion: number;
  total: number;
  cached: number;
  cacheWrite: number;
  cost: number;
}

export function emptyTotals(): UsageTotals {
  return {
    calls: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    cached: 0,
    cacheWrite: 0,
    cost: 0,
  };
}

export function addUsage(totals: UsageTotals, u: Usage): UsageTotals {
  return {
    calls: totals.calls + 1,
    prompt: totals.prompt + (u.prompt_tokens ?? 0),
    completion: totals.completion + (u.completion_tokens ?? 0),
    total: totals.total + (u.total_tokens ?? 0),
    cached: totals.cached + cachedTokens(u),
    cacheWrite: totals.cacheWrite + cacheWriteTokens(u),
    cost: totals.cost + (u.cost ?? 0),
  };
}

export function usageTotals(usages: Usage[]): UsageTotals {
  return usages.reduce(addUsage, emptyTotals());
}

/** Overall cache-hit fraction for a set of totals, 0..1. */
export function totalsCacheHitRate(totals: UsageTotals): number {
  if (totals.prompt <= 0) return 0;
  return totals.cached / totals.prompt;
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(fraction >= 0.1 ? 0 : 1)}%`;
}

/** Byte-ish char count formatting. */
export function formatChars(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}
