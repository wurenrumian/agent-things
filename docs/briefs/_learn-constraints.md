# Learn-wave shared constraints (L1 / L2)

These two worker briefs are a **parallel** wave. They are conflict-free by
construction:

- **L1 (cache forensics)** touches `apps/web/**` and `packages/core/**` (code).
- **L2 (learning kit)** creates only two new files under `docs/` (content).

The one rule that keeps this safe: **stay inside your own brief's Target list.**

Read `docs/SPEC.md` §3 (the three acceptance criteria: 可测量 / 可复现 / 可讲清)
first — this whole wave exists to serve them.

## Dependencies

Add **none**.

## Environment

- Only L1 may need API access. If so: copy the main worktree's gitignored `.env`
  into this worktree root (`copy D:/Project/agent-things/.env ./.env`; never
  commit it). L2 needs no `.env`.
- Model is `xiaomi/mimo-v2.6-flash`. Bound any API calls (≤ ~10) and back off on
  429. Prefer **zero-API** validation where possible.
- Do not start a long-lived HTTP server; use the existing experiment-script
  pattern in `packages/server/scripts/`.

## Finish protocol

- Where code changes: `pnpm typecheck` + `pnpm --filter @agent/web build` green.
- Commit as `L<n>: <name>` (do not push).
- Then send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a
  3-sentence summary, `--files-modified`, and `--report-path <your report>`.
  Then stop.
