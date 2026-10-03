import type { PermissionDecision } from "./events.js";
import type { ToolDef } from "./tools/registry.js";

/**
 * Permission layer (the "L7" seam). M0 is intentionally non-interactive: the
 * modes are coarse and the decision is synchronous. The point of doing it here
 * is to establish *where* the gate lives and to emit a decision event for every
 * call, so the interactive version is a drop-in later.
 */
export type PermissionMode = "yolo" | "standard" | "readonly";

export interface PermissionOutcome {
  decision: PermissionDecision;
  reason: string;
}

export function decidePermission(
  mode: PermissionMode,
  tool: ToolDef,
): PermissionOutcome {
  if (mode === "yolo") {
    return { decision: "allow", reason: "mode=yolo" };
  }
  if (mode === "readonly") {
    return tool.readOnly
      ? { decision: "allow", reason: "read-only tool" }
      : { decision: "deny", reason: "mode=readonly blocks mutations" };
  }
  // standard: read-only allowed; mutations need a human, which M0 lacks.
  return tool.readOnly
    ? { decision: "allow", reason: "read-only tool" }
    : {
        decision: "deny",
        reason: "mode=standard requires interactive approval (not in M0)",
      };
}
