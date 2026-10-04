/**
 * Tiny id helper for the orchestrator. Hand-rolled on purpose: the mechanism
 * adds no dependency. `Date.now()` plus a process-local counter keeps ids
 * unique and roughly sortable for observability output.
 */

let counter = 0;

/** Build an id like `worker-m1x2k3-4`. */
export function nextId(prefix = "id"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}
