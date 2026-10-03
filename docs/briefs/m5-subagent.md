# Worker brief — M5 Subagent & context isolation

Read `docs/briefs/_wave-constraints.md` and `packages/core/src/mechanisms/README.md`
first; they are binding.

## Target

`packages/core/src/mechanisms/subagent/**`, `packages/server/scripts/subagent-experiment.ts`,
`docs/runs/m5-subagent.md`, `docs/mechanisms/subagent.md`.

## Change

1. **Subagent primitive.** Implement `runSubagent(...)` and a `task` `ToolDef`
   (import `ToolDef`/`Agent`/`ToolRegistry`/`OpenRouterClient` from `@agent/core`).
   `execute()` constructs a **fresh `Agent`** with its own message array and system
   prompt, runs the given prompt to completion using the builtin tools (minus
   `task`, to prevent recursion), and returns **only the final assistant text** as
   the tool result. The subagent's intermediate tool outputs must never enter the
   parent's context.
2. **Experiment.** Pick a task whose investigation produces a lot of tool output
   (e.g. read several files and summarize). Run it two ways and measure with real
   usage:
   - (a) the main agent does it **inline** — the parent context accumulates every
     tool result;
   - (b) the main agent **delegates** via `task` — the parent receives only the
     final summary.
   Report, for each: the parent's final `prompt_tokens` (main-context size), the
   total tokens and cost across all calls, and how many tokens delegation saved.
3. **Teaching doc + findings.** `docs/mechanisms/subagent.md` explains isolation +
   result re-injection and when delegation pays off; `docs/runs/m5-subagent.md`
   holds the ledger.

## Constraints

As `_wave-constraints.md`. New files only; no dependency; no core/server/web edits.
Keep API usage bounded (≤ ~20 calls); back off on 429.

## Ownership

You own the four paths under Target and nothing else.

## Observable acceptance

- Both (a) and (b) run end-to-end against the real model.
- `docs/runs/m5-subagent.md` contains the token ledger and answers MECHANISMS §6 Q5.
- `pnpm typecheck` green; commit `M5: subagent & context isolation`.

## Finish protocol

Send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/runs/m5-subagent.md`. Then stop.
