# Worker brief — M1 cache & token economics

## Target

The cache/usage observability of `agent-things`, and the claims about prompt-cache
behaviour in `docs/MECHANISMS.md` §2–§3 (§6 lists the questions to answer).

In scope: `packages/server/scripts/**`, `packages/server/package.json` (a new
script only), `apps/web/src/components/UsageTab.tsx` (+ small helpers),
`docs/runs/m1-cache.md`.

## Change

Produce **measured** answers to the cache questions, not restated beliefs.

1. **Experiment harness.** Add `packages/server/scripts/cache-experiment.ts`
   (run with `tsx`), using `OpenRouterClient` from `@agent/core` directly so the
   only variable is the request. It must run, for the configured model, and print
   `usage.prompt_tokens_details.cached_tokens` (and cache_write) for each call:

   - **baseline** — send the *identical* request N=4 times; show cached climbing.
   - **tool-order shuffle** — same content, but reverse the `tools` array order;
     show the effect on cached.
   - **tool-set change** — add one extra tool to the array; show the effect.
   - **system change** — change one byte of the system message; show the effect.
   - **append-only** — grow the message array by appending, never editing the
     prefix; show the healthy case.

   Print a compact table per experiment (call #, prompt, cached, cache_write).

2. **Web aggregation.** In the Usage tab, show a **running cache hit rate**
   (`sum(cached)/sum(prompt)`) and a running **cost** for the session, so the
   observatory makes caching visible at a glance. Keep it consistent with the
   existing types.

3. **Findings doc.** `docs/runs/m1-cache.md` with the **actual numbers** from a
   real run of the harness, and a conclusion per question: which of the
   MECHANISMS §2–§3 claims held, which did not, and the observed cache-drop the
   policy must avoid. Include the exact command used.

## Constraints

- Do **not** change `docs/CONTRACT.md`, the `AgentEvent` vocabulary, or any
  frozen interface. Additive only.
- Do **not** modify `packages/core/src/**` except if a genuine bug blocks the
  experiment (if so, note it in the findings doc and keep the change minimal).
- The API key is **not** in this worktree. Copy the main worktree's env file into
  this worktree root before running:
  `cp D:/Project/agent-things/.env ./.env` (it stays gitignored). Never commit it.
- Do not run a long-lived server; the harness talks to OpenRouter directly.
- Keep `pnpm typecheck` green across all packages.

## Ownership

You own every file listed under **Target**. Do not touch `packages/server/src/**`
(the HTTP shell), `packages/core/src/**` (except the narrow bug exception), or
other mechanism directories.

## Observable acceptance

- `pnpm --filter @agent/server exec tsx scripts/cache-experiment.ts` runs to
  completion and prints real cached-token numbers.
- `docs/runs/m1-cache.md` contains those numbers and an explicit
  confirmed/refuted verdict per MECHANISMS §6 question.
- `pnpm typecheck` is green.
- Commit as `M1: cache & token economics` (do not push).

## Finish protocol

When done, send `worker_done` via the injected orchestration preamble with
`--outcome succeeded`, the two lifecycle IDs, a three-sentence summary, and
`--files-modified` / `--report-path docs/runs/m1-cache.md`. Then stop.
