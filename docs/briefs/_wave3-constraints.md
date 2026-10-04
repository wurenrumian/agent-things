# Wave 3 shared constraints (M9 / M10 / M11)

Read `packages/core/src/mechanisms/README.md` first. These constraints apply to
all three wave-3 briefs; each also has its own specific brief.

## You may create / edit ONLY

- `packages/core/src/mechanisms/<name>/**`  (your mechanism, new files only)
- `packages/server/scripts/<name>-experiment.ts`  (new file)
- `docs/runs/<name>.md`  (findings, new file)
- `docs/mechanisms/<name>.md`  (teaching doc, new file)

## You must NOT edit

Anything else, and in particular:

- any existing file under `packages/core/src/**` (including `types.ts`,
  `events.ts`, `index.ts`, `agent/loop.ts`, `tools/**`, `permissions.ts`,
  `content.ts`, `provider/openrouter.ts`, `context/system-prompt.ts`)
- `packages/server/src/**`, `apps/web/**`
- any `package.json`, `pnpm-lock.yaml`, root config
- `docs/CONTRACT.md`, `docs/MECHANISMS.md`, `docs/ROADMAP.md`,
  `docs/briefs/**` (read-only)

Wiring into the server/web/contract is a **separate later integration wave**
(`INT-*`), done by a single worker. Keep everything importable from your own
directory with relative paths so that wiring is mechanical.

## Dependencies

Add **none**. Hand-roll what you need (file persistence, ranking, mailbox).
If you truly need a dependency, stop and send a `question`.

## Environment

- This worktree has no `.env`. Before running: copy the main worktree's
  gitignored `.env` into this worktree's root (never commit it):
  `copy D:/Project/agent-things/.env ./.env`
- Model is `xiaomi/mimo-v2.6-flash`. Prompt cache works on it; see
  `docs/runs/m1-cache.md` (cache) and `docs/runs/m4-mcp.md` (tool schema cost).
- Keep API call counts small (≤ ~30 per experiment). On HTTP 429, back off and
  retry.
- Do not start a long-lived HTTP server; experiment scripts call OpenRouter
  directly.
- This is a teaching project: every mechanism needs **real `usage` data**, not a
  claim. `cached_tokens` lives in `usage.prompt_tokens_details.cached_tokens`.

## Finish protocol

- `pnpm typecheck` must be green across all packages.
- Commit as `M<n>: <name>` (do not push).
- Then send `worker_done` from the injected preamble with `--outcome succeeded`,
  both lifecycle IDs, a 3-sentence summary, `--files-modified`, and
  `--report-path docs/runs/<name>.md`. Then stop.
