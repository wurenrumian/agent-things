/**
 * `use_skill` — the tail-injection half of progressive disclosure.
 *
 * The model sees only L1 metadata (resident, from `SkillRegistry.metadataBlock()`).
 * When it decides it needs a skill, it calls this tool and the registry's L2 body
 * comes back as a **tool result**. Tool results are appended at the tail of the
 * message array, so the already-cached prefix (system + metadata + history) stays
 * byte-identical — no system-prompt rewrite, no cache invalidation.
 *
 * The executor is intentionally pure: it reads from the registry and returns a
 * string. It never mutates conversation state.
 */

import type { JSONSchema } from "../../types.js";
import type { ToolContext, ToolDef, ToolResult } from "../../tools/registry.js";
import type { SkillRegistry } from "./registry.js";

const PARAMETERS: JSONSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "Skill name exactly as listed in the available skills.",
    },
    reference: {
      type: "string",
      description:
        "Optional L3 reference file (relative to the skill directory) to load with the body.",
    },
  },
  required: ["name"],
};

/**
 * Build the `use_skill` tool bound to a registry. The returned `execute` yields
 * the skill body (L2) as a tool result, optionally followed by one referenced
 * file (L3).
 */
export function createUseSkillTool(registry: SkillRegistry): ToolDef {
  return {
    name: "use_skill",
    description:
      "Load the full instructions of a skill by name. Call this when a skill's " +
      "description matches the task; it returns the skill body as a tool result.",
    readOnly: true,
    parameters: PARAMETERS,
    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const name = typeof input["name"] === "string" ? input["name"].trim() : "";
      if (name === "") {
        return { output: 'missing required string argument "name"', isError: true };
      }
      if (!registry.has(name)) {
        const available = registry.list().map((m) => m.name).join(", ") || "(none)";
        return { output: `unknown skill "${name}". Available: ${available}`, isError: true };
      }

      const body = await registry.loadBody(name);
      const reference =
        typeof input["reference"] === "string" ? input["reference"].trim() : "";
      if (reference === "") return { output: body };

      try {
        const referenced = await registry.loadReference(name, reference);
        return {
          output: `${body}\n\n<!-- referenced file: ${reference} -->\n${referenced}`,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          output: `${body}\n\n<!-- failed to load reference "${reference}": ${message} -->`,
        };
      }
    },
  };
}
