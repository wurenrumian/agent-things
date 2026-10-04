# Worker brief — M9 Memory

Read `docs/briefs/_wave3-constraints.md` and
`packages/core/src/mechanisms/README.md` first; they are binding. Also read
`docs/MECHANISMS.md` §5 (memory hooks) and `docs/runs/m1-cache.md` +
`docs/runs/m2-skills.md` (cache behavior of injection points).

## Target

- `packages/core/src/mechanisms/memory/**`
- `packages/server/scripts/memory-experiment.ts`
- `docs/runs/m9-memory.md`
- `docs/mechanisms/memory.md`

## Change

Memory is the one third-lesson mechanism this project never built. Implement it
as a **self-contained** mechanism whose teaching point is: *memory is just
context injected at the right time — and the injection point decides whether it
breaks the prompt cache.*

1. **`MemoryStore`.** Append-only, hand-rolled persistence (no dependency; a
   newline-delimited JSON file under a configurable directory is fine). An entry
   is `{ id, text, tags?, createdAt, updatedAt? }`. API at least:
   `open(dir)`, `save(text, tags?)`, `all()`, `search(query, limit)`,
   `forget(id)`. `search` must be **deterministic** (keyword overlap + recency;
   no embeddings).
2. **`recall(query, opts)`** — return the top-K entries for a query using the
   same ranking, so the coordinator can pre-fetch without the model.
3. **`createMemoryTool(store)`** — one `ToolDef` named `memory` with an `action`
   of `save` | `list` | `search` | `forget`. Its output is the only thing that
   enters the model's context, and it enters at the **tail** (tool result).
4. **`renderMemories(entries)`** — a small helper that formats entries into a
   stable text block, plus an exported helper that can produce it either as a
   system-prompt suffix or as a tail message. Document the public API in
   `index.ts` so the later integration wave wires it without guessing.

## Experiment (real usage required)

1. **Cross-session persistence.** Session A (fresh `Agent`) saves 2–3 facts via
   the `memory` tool. Session B (a *different*, fresh `Agent` / session id)
   recalls a fact it could not otherwise know, via `memory search`. Show the two
   entries and the recalled text. This is the proof that memory survives a
   session.
2. **Cache experiment — injection point.** Over ≥3 identical calls each, compare:
   - **(a) prefix rewrite:** memories rendered into the system prompt
     (`systemPromptOverride`);
   - **(b) tail injection:** memories delivered as a tool result / tail message.
   Report per call `prompt_tokens` and
   `usage.prompt_tokens_details.cached_tokens`. The expected finding (to confirm
   or refute): (b) keeps the cached prefix, (a) collapses it.

## Constraints

As `_wave3-constraints.md`. New files only; no dependency; no core/server/web
edits. Keep API usage bounded (≤ ~30 calls); back off on 429.

## Ownership

You own the four paths under Target and nothing else.

## Observable acceptance

- Both the cross-session demo and the cache experiment run end-to-end against the
  real model.
- `docs/runs/m9-memory.md` contains the recall transcript and the cache ledger,
  and answers MECHANISMS §5 "改记忆是否炸缓存 / memory 注入位置".
- `docs/mechanisms/memory.md` teaches the mechanism (store + recall + injection)
  from scratch.
- `pnpm typecheck` green; commit `M9: memory`.

## Finish protocol

Send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/runs/m9-memory.md`. Then stop.
