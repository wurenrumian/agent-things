/**
 * Progressive-disclosure skill registry (M2, L4 in MECHANISMS.md).
 *
 * A *skill* is a directory containing a `SKILL.md` with a small frontmatter
 * header. The registry exposes the three disclosure levels the mechanism is
 * about:
 *
 *   L1 — metadata   : name + description, tiny and stable, safe to keep resident
 *                     in the prompt (see `metadataBlock()`).
 *   L2 — body       : the `SKILL.md` body, loaded only on demand
 *                     (`loadBody()`); the `use_skill` tool returns exactly this.
 *   L3 — references : relative files the body points at, loaded further on
 *                     demand (`references()` / `loadReference()`).
 *
 * Nothing here rewrites the system prompt. The intended wiring is: put L1 in the
 * stable prefix once, then let the model pull L2/L3 into context at the *tail*
 * (a tool result), which leaves the already-cached prefix intact.
 *
 * Self-contained by design: only `node:fs`/`node:path` and our own parser.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "./frontmatter.js";

/** L1 record for one skill. */
export interface SkillMetadata {
  /** Frontmatter `name`, or the directory name when absent. */
  name: string;
  /** Frontmatter `description` (may be empty). */
  description: string;
  /** Directory name; the stable on-disk id. */
  id: string;
  /** Absolute path to the skill directory. */
  dir: string;
  /** Absolute path to `SKILL.md`. */
  file: string;
}

/** Options for rendering the L1 metadata block. */
export interface MetadataBlockOptions {
  /** Include the one-line description (default true). */
  includeDescription?: boolean;
}

/** Markdown link targets: `[label](reference/foo.md)`. */
const MD_LINK_RE = /\]\(([^)\s]+)\)/g;
/** Inline code spans: `` `reference/foo.md` ``. */
const CODE_SPAN_RE = /`([^`\n]+)`/g;

/** Resolve `target` inside `base`; refuse anything that escapes it. */
function resolveInside(base: string, target: string): string {
  const abs = path.resolve(base, target);
  const rel = path.relative(base, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`reference escapes skill directory: ${target}`);
  }
  return abs;
}

/** Heuristic: does this token look like a relative file reference? */
function looksLikeReference(token: string): boolean {
  if (token === "") return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(token)) return false; // scheme://...
  if (token.startsWith("#") || token.startsWith("/")) return false;
  return token.includes("/") || /\.[a-z0-9]{1,8}$/i.test(token);
}

export class SkillRegistry {
  private readonly root: string;
  private readonly byName = new Map<string, SkillMetadata>();
  /** Deterministic order for L1 rendering (and thus cache stability). */
  private order: string[] = [];

  private constructor(root: string) {
    this.root = root;
  }

  /**
   * Scan `<root>/*\/SKILL.md`. A missing directory is not an error: it yields an
   * empty registry, which keeps callers (and tests) simple.
   */
  static async scan(root: string): Promise<SkillRegistry> {
    const registry = new SkillRegistry(path.resolve(root));
    let entries;
    try {
      entries = await readdir(registry.root, { withFileTypes: true });
    } catch {
      return registry;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(registry.root, entry.name);
      const file = path.join(dir, "SKILL.md");
      let raw: string;
      try {
        const info = await stat(file);
        if (!info.isFile()) continue;
        raw = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const { data } = parseFrontmatter(raw);
      const name = (data["name"] ?? entry.name).trim() || entry.name;
      if (registry.byName.has(name)) continue; // first definition wins
      registry.byName.set(name, {
        name,
        description: (data["description"] ?? "").trim(),
        id: entry.name,
        dir,
        file,
      });
      registry.order.push(name);
    }

    registry.order = [...registry.order].sort((a, b) => a.localeCompare(b));
    return registry;
  }

  /** Directory that was scanned. */
  rootDir(): string {
    return this.root;
  }

  /** Number of discovered skills. */
  size(): number {
    return this.order.length;
  }

  /** L1 metadata, deterministically ordered by name. */
  list(): SkillMetadata[] {
    return this.order
      .map((name) => this.byName.get(name))
      .filter((m): m is SkillMetadata => m !== undefined);
  }

  /** The directory containing the bundled demo fixture. */
  static fixtureDir(): string {
    // `import.meta.url` points at this module under tsx / ESM. `fileURLToPath`
    // handles Windows drive letters correctly (unlike URL.pathname).
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.join(here, "fixtures", "skills");
  }

  /** Load the bundled demo registry. */
  static async fromFixture(): Promise<SkillRegistry> {
    return SkillRegistry.scan(SkillRegistry.fixtureDir());
  }

  get(name: string): SkillMetadata | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /**
   * L1: render the resident metadata block. Keep this stable and small — every
   * byte here lives in the cached prefix, so order and formatting must not
   * change between turns.
   */
  metadataBlock(options: MetadataBlockOptions = {}): string {
    const includeDescription = options.includeDescription !== false;
    const lines = this.list().map((m) =>
      includeDescription && m.description
        ? `- ${m.name}: ${m.description}`
        : `- ${m.name}`,
    );
    return lines.join("\n");
  }

  /** L2: the `SKILL.md` body with the frontmatter stripped. */
  async loadBody(name: string): Promise<string> {
    const meta = this.#require(name);
    const raw = await readFile(meta.file, "utf8");
    return parseFrontmatter(raw).body;
  }

  /** L3: relative file references parsed out of the body (existing files only). */
  async references(name: string): Promise<string[]> {
    const meta = this.#require(name);
    const body = await this.loadBody(name);
    const candidates = new Set<string>();
    for (const re of [MD_LINK_RE, CODE_SPAN_RE]) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(body)) !== null) {
        const token = (match[1] ?? "").trim();
        if (!looksLikeReference(token)) continue;
        candidates.add(token.replace(/^\.\//, ""));
      }
    }

    const found: string[] = [];
    for (const candidate of candidates) {
      try {
        const abs = resolveInside(meta.dir, candidate);
        const info = await stat(abs);
        if (info.isFile()) found.push(candidate);
      } catch {
        // escaping or missing: not a loadable reference
      }
    }
    return found.sort((a, b) => a.localeCompare(b));
  }

  /** L3: read one referenced file, safely confined to the skill directory. */
  async loadReference(name: string, reference: string): Promise<string> {
    const meta = this.#require(name);
    const abs = resolveInside(meta.dir, reference);
    return readFile(abs, "utf8");
  }

  #require(name: string): SkillMetadata {
    const meta = this.byName.get(name);
    if (!meta) throw new Error(`unknown skill: ${name}`);
    return meta;
  }
}
