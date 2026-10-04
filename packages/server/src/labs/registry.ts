/**
 * L3 — Labs catalog.
 *
 * This module is the **allowlist**: exactly one entry per experiment harness in
 * `packages/server/scripts/`. The runner and the HTTP routes resolve runs
 * against this list and never accept a caller-supplied path, so the server can
 * only ever spawn a script named below.
 *
 * `kind: "offline"` means the harness is pure `@agent/core` + `node:` built-ins
 * (no `.env`, no network). `kind: "api"` means it talks to OpenRouter; the
 * `apiCalls` figure is the harness's own stated budget, surfaced in the UI so a
 * learner can see the cost before confirming a run.
 */

import type { Lab } from "./types.js";

/**
 * The catalog, ordered to follow the learning path (foundations → cache →
 * mechanisms → orchestration). `docsRun` points at the recorded evidence for
 * the mechanism.
 */
export const LABS: readonly Lab[] = [
  {
    id: "cache",
    title: "Prompt-cache priming",
    mechanism: "cache",
    kind: "api",
    apiCalls: 5,
    estSeconds: 30,
    script: "cache-experiment.ts",
    docsRun: "docs/runs/m1-cache.md",
    blurb:
      "Warms a stable prefix, then shows provider-reported cached_tokens for identical vs rewritten requests.",
  },
  {
    id: "forensics",
    title: "Cache forensics classifier",
    mechanism: "forensics",
    kind: "offline",
    script: "forensics-experiment.ts",
    docsRun: "docs/runs/l1-cache-forensics.md",
    blurb:
      "Feeds six crafted request pairs to diffRequests() and prints the first-divergent-block verdict. Zero API calls.",
  },
  {
    id: "skills",
    title: "Skills & progressive disclosure",
    mechanism: "skills",
    kind: "api",
    apiCalls: 12,
    estSeconds: 60,
    script: "skills-experiment.ts",
    docsRun: "docs/runs/m2-skills.md",
    blurb:
      "Loads a skill body as a user message, a tool result, or a system rewrite, and measures which keeps the cache warm.",
  },
  {
    id: "compaction",
    title: "Compaction & context reclamation",
    mechanism: "compaction",
    kind: "api",
    apiCalls: 21,
    estSeconds: 90,
    script: "compaction-experiment.ts",
    docsRun: "docs/runs/m3-compaction.md",
    blurb:
      "Compares spliced vs leading summary placement and tracks how fast the cache recovers after the prefix is rewritten.",
  },
  {
    id: "mcp",
    title: "MCP tool injection",
    mechanism: "mcp",
    kind: "api",
    apiCalls: 20,
    estSeconds: 90,
    script: "mcp-experiment.ts",
    docsRun: "docs/runs/m4-mcp.md",
    blurb:
      "Runs a real stdio MCP round-trip, then shows the cache cost of adding and reordering the discovered tool schemas.",
  },
  {
    id: "subagent",
    title: "Subagent context isolation",
    mechanism: "subagent",
    kind: "api",
    apiCalls: 10,
    estSeconds: 60,
    script: "subagent-experiment.ts",
    docsRun: "docs/runs/m5-subagent.md",
    blurb:
      "Contrasts a direct answer with a delegated `task` call to show the token ledger effect of an isolated child context.",
  },
  {
    id: "hooks",
    title: "Permissions, hooks & checkpoints",
    mechanism: "hooks",
    kind: "offline",
    script: "hooks-experiment.ts",
    docsRun: "docs/runs/m6-permissions.md",
    blurb:
      "Gates representative tool calls through the policy + hooks, then round-trips a checkpoint snapshot like a rewind. Zero API calls.",
  },
  {
    id: "scheduler",
    title: "Background & scheduled tasks",
    mechanism: "scheduler",
    kind: "offline",
    script: "scheduler-experiment.ts",
    docsRun: "docs/runs/m7-scheduler.md",
    blurb:
      "Exercises one-shot, background, cancel and interval tasks with real timers and re-injects each result. Zero API calls.",
  },
  {
    id: "memory",
    title: "Memory persistence & injection point",
    mechanism: "memory",
    kind: "api",
    apiCalls: 30,
    estSeconds: 120,
    script: "memory-experiment.ts",
    docsRun: "docs/runs/m9-memory.md",
    blurb:
      "Proves cross-session recall, then compares prefix-rewrite vs tail-injection for whether changing memory blows the cache.",
  },
  {
    id: "orchestrator",
    title: "Orchestrator & worker mailbox",
    mechanism: "orchestrator",
    kind: "api",
    apiCalls: 20,
    estSeconds: 90,
    script: "orchestrator-experiment.ts",
    docsRun: "docs/runs/m10-orchestrator.md",
    blurb:
      "Spawns workers, drives mailbox question/answer and settlement, and checks durability across a reload. Mix of local and model legs.",
  },
  {
    id: "tool-search",
    title: "Lazy tool exposure",
    mechanism: "tool-search",
    kind: "api",
    apiCalls: 30,
    estSeconds: 120,
    script: "tool-search-experiment.ts",
    docsRun: "docs/runs/m11-tool-search.md",
    blurb:
      "Shows the schema-token cost of always-on tools vs a two-tool facade that loads schemas on demand.",
  },
  {
    id: "approval",
    title: "Interactive approval & slash commands",
    mechanism: "approval",
    kind: "api",
    apiCalls: 5,
    estSeconds: 45,
    script: "approval-experiment.ts",
    docsRun: "docs/runs/m12.md",
    blurb:
      "Runs the command-registry self-test, then a real gated write turn resolved first as deny and then as allow.",
  },
] as const;

/** Look up one lab by its stable id (the only way a run target is resolved). */
export function findLab(id: string): Lab | undefined {
  return LABS.find((lab) => lab.id === id);
}
