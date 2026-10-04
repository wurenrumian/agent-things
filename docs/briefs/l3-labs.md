# Worker brief — L3: Labs (experiments as one-click, live ledger)

Work on top of `master` (has M0–M12, INT-C, L1/L2). This wave edits shared
server/web files, so you are the only worker. Read `docs/SPEC.md` §3,
`docs/LEARNING.md` ("怎么自己复现"), `docs/briefs/_learn-constraints.md`,
`packages/server/src/{config,index}.ts`, `apps/web/src/components/Observatory.tsx`
+ `App.tsx`, and skim every `packages/server/scripts/*-experiment.ts` to build the
catalog.

## The learning goal

Today a learner must drop to a terminal and run
`pnpm --filter @agent/server exec tsx scripts/<x>-experiment.ts`. Turn the
observatory into a **teaching instrument**: a **Labs** tab that catalogs every
experiment and runs it with the output streaming live. Reuse the scripts — do
**not** rewrite the experiments.

## Target (you own these)

- `packages/server/src/labs/**` (NEW: `types.ts`, `registry.ts`, `runner.ts`)
- `packages/server/src/config.ts`, `packages/server/src/index.ts`
- `apps/web/**`
- `docs/CONTRACT.md` (add `GET /api/labs`, `POST /api/labs/:id/run`, new env)
- `docs/runs/l3-labs.md` (NEW), `docs/labs.md` (NEW)
- You may **read but not edit** `packages/server/scripts/**` and every
  `docs/runs/*.md`, `docs/mechanisms/*.md`.

## Change

1. **Catalog** (`labs/registry.ts`). One entry per experiment script (there are
   ~12: approval, cache, compaction, hooks, mcp, memory, orchestrator, scheduler,
   skills, subagent, tool-search, forensics). Each:
   `{ id, title, mechanism, kind: "offline" | "api", apiCalls?: number,
   estSeconds?: number, script: "cache-experiment.ts", docsRun: "docs/runs/….md",
   blurb }`. This registry is the **allowlist** — the server must never accept a
   caller-supplied path. Mark `kind:"offline"` for the zero-API ones (at least
   `hooks`, `scheduler`, `forensics`; verify against each run doc) and `api` for
   the rest.
2. **Runner** (`labs/runner.ts`). Given a registry id, spawn the allowlisted
   script as a child process and stream it. Requirements:
   - Command: whatever actually works from the server's cwd (e.g. `pnpm exec tsx`
     or the hoisted `tsx` binary); must work on Windows. Pass `process.env`
     through so `.env`'s key is available to API labs.
   - Frame protocol (streamed): `{type:"start",id,command}` →
     `{type:"stdout",line}` / `{type:"stderr",line}` → `{type:"exit",code,durationMs}`.
   - Guards: `LABS_ENABLED` (default `true`); `LAB_TIMEOUT_MS` (default `300000`)
     kills the process **tree** and emits an `exit` with a timeout marker; kill on
     client disconnect; **at most one running lab at a time** (a second request
     gets `409 busy`).
3. **Routes** (`index.ts`): `GET /api/labs` → the catalog; `POST /api/labs/:id/run`
   → `streamSSE` of the frames above (404 unknown id, 409 busy, 403 when
   `LABS_ENABLED=false`).
4. **Web**: a **Labs** tab. List the catalog grouped by `kind`, each with title,
   blurb, mechanism, `apiCalls` (with a visible warning + an explicit confirm
   before running an `api` lab), a link to its `docsRun`, and a **Run** button.
   Running shows a live stdout/stderr console and the exit status/duration.
   Reuse the existing tab/App wiring; keep other tabs working.
5. **Docs**: `docs/labs.md` teaches the Labs design (allowlist + child process +
   streamed ledger) and how to add a lab; `docs/runs/l3-labs.md` is your report
   with the boot/route evidence.

## Constraints

- No new dependency. `.env` gitignored; never commit it.
- **Unconfigured/other paths unchanged**: with `LABS_ENABLED=false` the routes
  are inert and the rest of the server behaves exactly as before.
- Never run a script on page load; only on an explicit Run.
- Bound your own validation API usage (prefer running an **offline** lab such as
  `forensics` end-to-end through the route).

## Observable acceptance

- `pnpm typecheck` (4 packages) and `pnpm --filter @agent/web build` green.
- `GET /api/labs` returns the full catalog (~12, with correct `kind`/`apiCalls`).
- With the server running, `POST /api/labs/forensics/run` streams the classifier
  table and an `exit` frame with code `0` (offline, no API); a second concurrent
  run returns `409`.
- The web Labs tab renders the catalog and shows a live console for a run.
- `docs/labs.md` + `docs/runs/l3-labs.md` written.
- Commit `L3: labs`.

## Finish protocol

Send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/runs/l3-labs.md`. Then stop.
