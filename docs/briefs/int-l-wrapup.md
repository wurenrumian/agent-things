# Worker brief — INT-L: discoverability wrap-up (final)

Small, serial, final wave. Run this only **after L3 has merged** into `master`.
Goal: make the learning artifacts discoverable and mark the learning wave done.
No new features.

## Target (you own these)

- `README.md`
- `docs/ROADMAP.md`, `docs/STATE.md`
- `docs/MECHANISMS.md` (a short pointer only — do not rewrite content)
- `apps/web/**` (navigation/discoverability only)

## Change

1. **README** — add a short **"学习路径 / 学习工具"** section near the top that
   links, with repo-relative links:
   - `docs/LEARNING.md`（三节课路径）
   - `docs/MYTHS.md`（常识 vs 实测）
   - `docs/labs.md`（Labs 实验台）
   and mention the two read-only observatory tools now available: the
   **Forensics** tab（谁破坏了缓存）and the **Labs** tab（实验即按钮）.
2. **Web discoverability** — add a small, unobtrusive way to reach the learning
   docs from the app (e.g. a "Learn" / "?" affordance linking to the docs or an
   in-app panel listing LEARNING/MYTHS/Labs). Keep it minimal and consistent with
   the existing tab/nav styling; do not restructure the app.
3. **ROADMAP** — mark L1/L2/L3 as done in the 学习辅助 section.
4. **STATE** — add a short handoff note: what the learning wave delivered
   (L1 forensics, L2 docs, L3 labs), current HEAD, and that the run is settled.
5. **MECHANISMS** — only a one-line pointer at the top of §7 to
   `docs/MYTHS.md`; change nothing else.

## Constraints

- No new dependency; no protocol/route changes; do not edit `packages/server/**`
  or the mechanism directories.
- Every link must resolve to a real file; verify before finishing.

## Observable acceptance

- `pnpm typecheck` + `pnpm --filter @agent/web build` green.
- README links to LEARNING/MYTHS/labs all resolve; the app has a working path to
  the learning docs.
- ROADMAP/STATE/MECHANISMS updated as above.
- Commit `INT-L: learning docs + nav wrap-up`.

## Finish protocol

Send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/STATE.md`. Then stop.
