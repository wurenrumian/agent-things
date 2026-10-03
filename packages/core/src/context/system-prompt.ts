import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ContextSection } from "../events.js";

/**
 * System-prompt / context assembly (the "L1" layer).
 *
 * This is the most under-appreciated part of an agent. The system prompt is not
 * one blob: it is a stack of labelled sections, and *what order they are in*
 * determines whether the provider's prompt cache can hit. Stable sections must
 * come first; volatile sections (like the cwd listing) come last.
 */

export interface PromptSection {
  name: string;
  content: string;
  /** Stable sections are candidates for cache breakpoints. */
  stable: boolean;
}

export interface SystemPrompt {
  text: string;
  sections: PromptSection[];
}

export interface BuildPromptOptions {
  cwd: string;
  platform?: string;
  /** Extra instructions appended last (e.g. user config). */
  extraInstructions?: string;
  /** Skip the directory listing (used by tests / read-only phases). */
  includeDirectory?: boolean;
  /** Injectable for tests. */
  maxMemoryChars?: number;
}

const IDENTITY = `You are a minimal coding agent built for study, called "agent-things".
You help the user with software tasks inside their working directory by reading
files, writing files, editing files, listing directories, and running shell commands.

Work iteratively: inspect before you change, make small edits, and verify with
commands when useful. Prefer the dedicated tools over shell equivalents. When a
task is complete, stop calling tools and reply with a concise summary.`;

/** Look for AGENTS.md from cwd up to the filesystem root. */
export async function discoverMemoryFiles(
  cwd: string,
  maxChars = 12_000,
): Promise<{ files: string[]; content: string }> {
  const files: string[] = [];
  const chunks: string[] = [];
  let dir = path.resolve(cwd);
  let budget = maxChars;

  while (true) {
    const candidate = path.join(dir, "AGENTS.md");
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        const raw = await readFile(candidate, "utf8");
        const clipped = raw.slice(0, Math.max(0, budget));
        budget -= clipped.length;
        files.push(candidate);
        chunks.push(`<!-- ${candidate} -->\n${clipped}`);
        if (budget <= 0) break;
      }
    } catch {
      // not present; keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Nearest file first reads more naturally.
  return { files, content: chunks.join("\n\n") };
}

async function describeDirectory(cwd: string, limit = 40): Promise<string> {
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    const lines = entries
      .filter((e) => !e.name.startsWith(".git"))
      .slice(0, limit)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return lines.join("\n");
  } catch {
    return "(unable to list directory)";
  }
}

export async function buildSystemPrompt(
  opts: BuildPromptOptions,
): Promise<SystemPrompt> {
  const platform = opts.platform ?? process.platform;
  const sections: PromptSection[] = [];

  sections.push({ name: "identity", content: IDENTITY, stable: true });

  sections.push({
    name: "environment",
    content: [
      `Working directory: ${opts.cwd}`,
      `Platform: ${platform}`,
      `Today: ${new Date().toISOString().slice(0, 10)}`,
    ].join("\n"),
    stable: false,
  });

  const memory = await discoverMemoryFiles(opts.cwd, opts.maxMemoryChars);
  if (memory.content) {
    sections.push({
      name: `memory (${memory.files.length} file(s))`,
      content: memory.content,
      stable: true,
    });
  }

  if (opts.includeDirectory !== false) {
    sections.push({
      name: "directory",
      content: await describeDirectory(opts.cwd),
      stable: false,
    });
  }

  if (opts.extraInstructions) {
    sections.push({
      name: "extra instructions",
      content: opts.extraInstructions,
      stable: true,
    });
  }

  const text = sections
    .map((s) => `<${s.name}>\n${s.content}\n</${s.name}>`)
    .join("\n\n");

  return { text, sections };
}

/** Convert prompt sections into observatory-friendly stats. */
export function toContextSections(prompt: SystemPrompt): ContextSection[] {
  return prompt.sections.map((s) => ({
    name: s.name,
    chars: s.content.length,
    preview: s.content.slice(0, 200),
  }));
}
