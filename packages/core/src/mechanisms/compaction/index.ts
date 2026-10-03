/**
 * M3 — compaction & context reclamation.
 *
 * Two pure transformations over a message array, meant to be applied by a
 * caller *between* agent-loop steps (never by editing the loop):
 *
 * - {@link compact}          fold the middle of the history into one summary.
 * - {@link clearToolResults} empty old tool-result bodies, keep the envelopes.
 *
 * Plus {@link validateToolTranscript} to prove the result is still valid.
 *
 * Teaching doc: `docs/mechanisms/compaction.md`
 * Measurements:  `docs/runs/m3-compaction.md`
 */

export * from "./types.js";
export * from "./compact.js";
export * from "./clear-tool-results.js";
export * from "./validate.js";
