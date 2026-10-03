/**
 * Minimal, dependency-free frontmatter parser for `SKILL.md` files.
 *
 * Skills use a YAML-ish header delimited by `---`:
 *
 *   ---
 *   name: code-review
 *   description: Review a diff and report findings.
 *   ---
 *   # Body
 *   ...
 *
 * The real Claude Skills format allows full YAML. We deliberately support only
 * the flat `key: value` shape the registry needs (`name`, `description`), so we
 * can avoid a YAML dependency per the wave-1 constraints. Values may be wrapped
 * in single or double quotes; a trailing inline comment is *not* stripped (paths
 * and descriptions legitimately contain `#`).
 */

export interface Frontmatter {
  /** Flat key/value pairs from the `---` block, in file order. */
  data: Record<string, string>;
  /** Everything after the closing `---`, verbatim (may be empty). */
  body: string;
  /** Whether a `---` block was found at all. */
  hasFrontmatter: boolean;
}

export function parseFrontmatter(raw: string): Frontmatter {
  // Strip a UTF-8 BOM; editors on Windows add one happily.
  const text = raw.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
  if (!match) {
    return { data: {}, body: text, hasFrontmatter: false };
  }

  const data: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    if (key === "") continue;
    let value = trimmed.slice(colon + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }

  return { data, body: text.slice(match[0].length), hasFrontmatter: true };
}

/** Serialize a flat record back into a `---` frontmatter block. */
export function stringifyFrontmatter(data: Record<string, string>, body: string): string {
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}
