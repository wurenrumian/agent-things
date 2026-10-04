# Worker brief — L1: Cache forensics ("who broke the cache?")

Read `docs/briefs/_learn-constraints.md` and `docs/SPEC.md` §3 first; they are
binding. Also read `docs/runs/m1-cache.md`, `docs/runs/m4-mcp.md`,
`docs/runs/m2-skills.md`, `docs/runs/m3-compaction.md`,
`packages/core/src/types.ts` (`ChatRequest`), and
`apps/web/src/components/TimelineTab.tsx` + `Observatory.tsx` + `api.ts`.

## The learning goal

The single most important lesson in this project is **prefix stability**: the
provider cache is a byte-prefix of the serialized request, so the *first
divergent block* (system / tools / message i) decides the hit. Today a learner
must read M1/M2/M4 run docs and mentally diff request bodies. This tool makes
that causal step **visible**: given two consecutive requests, it points at the
exact block that changed and attributes it.

## Target (you own these)

- `packages/core/src/context-diff.ts` (NEW) and **one append-only export line**
  in `packages/core/src/index.ts`.
- `apps/web/src/**`
- `packages/server/scripts/forensics-experiment.ts` (NEW; zero-API validation)
- `docs/runs/l1-cache-forensics.md` (NEW)
- `docs/mechanisms/forensics.md` (NEW)

Do **not** edit `events.ts`, the mechanism directories, other server files, or
any other doc (ROADMAP/CONTRACT/STATE/README belong to the later INT).

## Change

1. **Pure diff helper** `context-diff.ts`. Export a deterministic,
   dependency-free function, e.g.:

   ```ts
   diffRequests(prev: ChatRequest, next: ChatRequest): {
     divergence: "none" | "system" | "tools" | "messages";
     firstDivergentBlock: "none" | "system" | "tools" | "messages";
     system: { same: boolean; changedAt?: number; prevLen: number; nextLen: number };
     tools:  { same: boolean; added: string[]; removed: string[]; reordered: boolean; firstDiffIndex?: number };
     messages: { prefixLen: number; appended: number; changedAt?: number };
   }
   ```

   Semantics must match M1/M4: the cacheable prefix is `system`, then the
   `tools` array (order-sensitive), then the message array (append-only is
   free). A pure append (no tool/system change) is `divergence: "none"` with
   `messages.appended > 0`. Unit-testable with no network.
2. **Experiment** `forensics-experiment.ts` — **zero API**. Construct request
   pairs from the recorded M1/M4 scenarios and assert the classification:
   - identical → `none`;
   - reversed `tools` order → `tools`, `reordered: true`;
   - one tool added → `tools`, `added: [name]`;
   - `system` changed 1 byte → `system`;
   - append-only message → `none`, `messages.appended > 0`;
   - `tools` identical but a middle message edited → `messages`, `changedAt` > prefix.
   Print a PASS/FAIL table. (If a real recorded session is available, you may
   additionally read it, but the assertions must not require the network.)
3. **Web** — add a **Forensics** view/tab: for the selected session, pair
   consecutive `request.sent` events (they carry the full body) and render, per
   pair: the divergence verdict, the changed block, the added/removed/reordered
   tool names, and the `usage.cached_tokens` before/after. Make the first
   divergent block visually obvious. Keep the existing tabs working.

## Constraints

As `_learn-constraints.md`; no new dependency; bounded API (ideally zero here);
do not rename or repurpose existing exports.

## Ownable acceptance

- `pnpm typecheck` (4 packages) and `pnpm --filter @agent/web build` green.
- `forensics-experiment.ts` prints an all-PASS table for the six cases above.
- The Forensics view, opened on a real session, points at the same divergent
  block the run docs describe (e.g. a tools reorder shows `tools`).
- `docs/runs/l1-cache-forensics.md` records the validation table;
  `docs/mechanisms/forensics.md` teaches the prefix model + how to read the view.
- Commit `L1: cache forensics`.

## Finish protocol

Send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/runs/l1-cache-forensics.md`.
Then stop.
