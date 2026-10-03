# Wave 1 shared constraints (M2 / M4 / M5)

Read `packages/core/src/mechanisms/README.md` first. These constraints apply to
all three wave-1 briefs; each also has its own specific brief.

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
- `docs/CONTRACT.md`, `docs/MECHANISMS.md`, `docs/ROADMAP.md`

## Dependencies

Add **none**. Hand-roll what you need (MCP = JSON-RPC over stdio; skill =
frontmatter parsing). If you truly need a dependency, stop and send a `question`.

## Environment

- This worktree has no `.env`. Before running: `copy D:/Project/agent-things/.env ./.env`
  (it is gitignored; never commit it).
- Model is `xiaomi/mimo-v2.6-flash`. Prompt cache works on it (see `docs/runs/m1-cache.md`).
- Keep API call counts small (≤ ~20 per experiment). On HTTP 429, back off and retry.
- Do not start a long-lived HTTP server; experiment scripts call OpenRouter directly.

## Finish protocol

- `pnpm typecheck` must be green across all packages.
- Commit as `M<n>: <name>` (do not push).
- Then send `worker_done` from the injected preamble with `--outcome succeeded`,
  both lifecycle IDs, a 3-sentence summary, `--files-modified`, and
  `--report-path docs/runs/<name>.md`. Then stop.
