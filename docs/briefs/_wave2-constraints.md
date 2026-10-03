# Wave 2 shared constraints (M3 / M6 / M7)

Read `packages/core/src/mechanisms/README.md` first. Same rules as wave 1.

## You may create / edit ONLY

- `packages/core/src/mechanisms/<name>/**`  (your mechanism, new files only)
- `packages/server/scripts/<name>-experiment.ts`  (new file)
- `docs/runs/<name>.md`  (findings, new file)
- `docs/mechanisms/<name>.md`  (teaching doc, new file)

M6 owns two mechanism dirs (`hooks/`, `checkpoint/`) but still only one script
and one pair of docs.

## You must NOT edit

Anything else, and in particular any existing file under `packages/core/src/**`
(including `permissions.ts` — build your enhanced policy in your own module),
`packages/server/src/**`, `apps/web/**`, any `package.json`/lockfile/root config,
and `docs/CONTRACT.md`, `docs/MECHANISMS.md`, `docs/ROADMAP.md`.

## Dependencies

Add **none**. Hand-roll. If you truly need a dependency, stop and send a `question`.

## Environment

- This worktree has no `.env`. Before running: `copy D:/Project/agent-things/.env ./.env`
  (gitignored; never commit).
- Model `xiaomi/mimo-v2.6-flash`. Prompt cache works on it (`docs/runs/m1-cache.md`,
  `docs/runs/m2-skills.md`).
- Keep API calls small (≤ ~25 per experiment). Back off on 429. Modules whose
  mechanism needs no model call (M6) must not call the API at all.

## Finish protocol

- `pnpm typecheck` green across all packages.
- Commit as `M<n>: <name>` (do not push).
- Send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
  summary, `--files-modified`, `--report-path docs/runs/<name>.md`. Then stop.
