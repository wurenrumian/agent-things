/**
 * Tiny id helper for the scheduler. Hand-rolled on purpose: the mechanism adds
 * no dependency. `Date.now()` plus a process-local counter is enough to keep
 * ids unique and roughly sortable for observability output.
 */

let counter = 0;

/** Build an id like `after-m1x2k3-4`. */
export function nextTaskId(prefix = "task"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Render any thrown value as a human-readable message. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}
