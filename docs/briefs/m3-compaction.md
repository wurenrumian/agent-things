# Worker brief — M3 Compaction & context reclamation

Read `docs/briefs/_wave2-constraints.md` and `packages/core/src/mechanisms/README.md`
first; they are binding.

## Target

`packages/core/src/mechanisms/compaction/**`, `packages/server/scripts/compaction-experiment.ts`,
`docs/runs/m3-compaction.md`, `docs/mechanisms/compaction.md`.

## Change

1. **Two reclamation primitives** (pure functions over a message array; do not
   touch the agent loop):
   - `compact(messages, { keepRecent, summarize })` — summarize the middle of the
     history into one summary message, keep a recent tail verbatim. `summarize` is
     injected so it can be a real model call or a stub.
   - `clearToolResults(messages, { keepLastN })` — replace the *content* of old
     `role:"tool"` messages with a short placeholder, **keeping the tool_call
     structure** so the transcript stays valid.
2. **Experiment** with `OpenRouterClient` directly (pattern in `docs/runs/m1-cache.md`):
   - Build a long conversation (enough to matter), measure `cached_tokens` before
     and after compaction (call 1 and call 2 after) → the **recovery curve**.
   - Compare summary placement: (i) summary **spliced into history** (rewrites the
     prefix) vs (ii) summary at a **fixed leading position** — measure the cache
     difference on subsequent turns.
   - Measure `clearToolResults` alone: token saved vs its cache effect, and compare
     to full `compact`.
3. **Teaching doc + findings** as usual.

## Constraints

As `_wave2-constraints.md`. Never edit the agent loop or `events.ts`.

## Ownership

You own the four paths under Target and nothing else.

## Observable acceptance

- Real `cached_tokens` curves: before compaction, after call-1, after call-2, for
  both summary placements; plus `clearToolResults` numbers.
- `docs/runs/m3-compaction.md` answers MECHANISMS §6 Q3 and discusses the §4
  PreCompact / cache-reuse tradeoff.
- `pnpm typecheck` green; commit `M3: compaction & context reclamation`.

## Finish protocol

Send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/runs/m3-compaction.md`. Then stop.
