# Worker brief — M6 Permissions, hooks & checkpoint

Read `docs/briefs/_wave2-constraints.md` and `packages/core/src/mechanisms/README.md`
first; they are binding. **No model calls in this milestone.**

## Target

`packages/core/src/mechanisms/hooks/**`, `packages/core/src/mechanisms/checkpoint/**`,
`packages/server/scripts/hooks-experiment.ts`, `docs/runs/m6-permissions.md`,
`docs/mechanisms/permissions.md`.

## Change

1. **Hook system** (`mechanisms/hooks/`). A `HookRunner` with lifecycle points
   `preToolUse`, `postToolUse`, `preCompact`, `userPromptSubmit`, matched by tool
   name (exact or regex). A hook returns one of: `allow`, `deny` (with reason),
   `ask`, or a **mutation** (rewritten tool input). Load hook config from a JSON
   file in the module's fixtures.
2. **Enhanced permission policy** (`mechanisms/hooks/`). Ordered rules
   `{ tool, argPattern?, decision }` → `allow | ask | deny`, combined with hooks
   into one `decide(request)` that returns a decision plus the reason and the
   contributing rule/hook. Model `ask` as a **pending** decision a UI could
   resolve — do not open an interactive prompt.
3. **Checkpoint** (`mechanisms/checkpoint/`). A `CheckpointStore` that snapshots a
   file's bytes before it is mutated, groups snapshots per turn, and can restore a
   turn (or a single file) byte-for-byte. Keep it independent of conversation
   history (the point: code rollback ≠ conversation rollback).
4. **Demo** (`scripts/hooks-experiment.ts`, no network): print a decision table for
   cases like `run_shell rm -rf`, `git push main`, a write that a rule sets to
   `ask`, a hook that mutates an argument, and a hook that denies; then run a
   checkpoint → mutate → restore round-trip and assert the bytes match.

## Constraints

As `_wave2-constraints.md`. Do not edit the existing `permissions.ts`; build your
policy in your own module. No dependencies.

## Ownership

You own the five paths under Target and nothing else.

## Observable acceptance

- A printed decision table covering allow / ask / deny / mutate / hook-deny.
- A checkpoint round-trip that restores a file to identical bytes.
- `docs/mechanisms/permissions.md` + `docs/runs/m6-permissions.md`.
- `pnpm typecheck` green; commit `M6: permissions, hooks & checkpoint`.

## Finish protocol

Send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/runs/m6-permissions.md`. Then stop.
