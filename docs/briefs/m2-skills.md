# Worker brief — M2 Skills & progressive disclosure

Read `docs/briefs/_wave-constraints.md` and `packages/core/src/mechanisms/README.md`
first; they are binding.

## Target

`packages/core/src/mechanisms/skills/**`, `packages/server/scripts/skills-experiment.ts`,
`docs/runs/m2-skills.md`, `docs/mechanisms/skills.md`.

## Change

1. **Progressive-disclosure skill registry.** Scan a `skills/` directory of
   `*/SKILL.md` files with a YAML-ish frontmatter block (`name`, `description`).
   Expose three levels: (L1) metadata only, (L2) the `SKILL.md` body, (L3)
   referenced files loaded on demand. Include a small demo `skills/` fixture in
   the module.
2. **Tail-injection tool.** Provide a `ToolDef` (import the type from core) named
   `use_skill` whose `execute` returns the L2 body — i.e. the body enters context
   as a *tool result at the tail*, never by rewriting the system prompt.
3. **Experiment.** With `OpenRouterClient` directly (pattern: `docs/runs/m1-cache.md`,
   use a fresh `--salt` per run), compare the `cached_tokens` curve for the same
   logical turn under three ways of getting the skill body into context:
   - (a) append it as a new **user message** at the tail;
   - (b) return it as a **tool result**;
   - (c) **rewrite the system prompt** to include it.
   Show warm-up call, then the injection call, then a follow-up call, for each.
4. **Teaching doc + findings.** `docs/mechanisms/skills.md` explains the mechanism;
   `docs/runs/m2-skills.md` holds the raw numbers.

## Constraints

As `_wave-constraints.md`. In particular: new files only; no dependency; do not
touch core's existing files; no server/web edits.

## Ownership

You own the four paths under Target and nothing else.

## Observable acceptance

- The experiment prints real `cached_tokens` per call for (a)/(b)/(c).
- `docs/runs/m2-skills.md` answers MECHANISMS §6 Q1 and confirms/refutes the §2
  claim: *metadata resident + body injected at the tail preserves the cache;
  rewriting the system prompt destroys it.*
- `pnpm typecheck` green; commit `M2: skills & progressive disclosure`.

## Finish protocol

Send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/runs/m2-skills.md`. Then stop.
