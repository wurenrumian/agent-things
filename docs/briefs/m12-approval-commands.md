# Worker brief — M12: interactive approval + slash commands

Work on top of `master`, which already contains M9/M10/M11 and INT-C. This
milestone edits shared kernel/server/web files, so you are the only worker in
this wave. Read first: `docs/CONTRACT.md`, `docs/MECHANISMS.md` (L7 + §7),
`docs/runs/m6-permissions.md`, `docs/runs/int-b1.md`,
`packages/core/src/{agent/loop.ts,permissions.ts,events.ts}`,
`packages/core/src/mechanisms/hooks/**`, `packages/server/src/{compose,index}.ts`,
and `docs/briefs/int-c-mechanisms.md` (the wiring pattern to follow).

## Target

- `packages/core/src/agent/loop.ts`, `packages/core/src/events.ts` (append-only)
- `packages/core/src/mechanisms/commands/**` (new)
- `packages/server/src/{config,compose,index}.ts`
- `apps/web/**` (approval UI)
- `docs/CONTRACT.md`, `docs/MECHANISMS.md`, `docs/ROADMAP.md`, `docs/STATE.md`, `README.md`
- `packages/server/scripts/approval-experiment.ts` (new)
- `docs/runs/m12.md`, `docs/mechanisms/approval.md`, `docs/mechanisms/commands.md`

## Part 1 — Interactive approval (primary)

Today the M6 gate can return `ask`, but the loop treats it non-interactively:
`yolo` proceeds optimistically, otherwise it is blocked (`loop.ts`
`executeToolCall`). Make `ask` a **real, awaited human decision**.

1. **Kernel seam (additive).** Add `AgentConfig.approvals?: (req: {
   toolCallId: string; tool: string; input: Record<string, unknown>; turnId:
   string }) => Promise<"allow" | "deny">`. In `executeToolCall`, when the
   resolved decision is `ask` and `approvals` is set, `await` it before deciding:
   - emit an `approval.requested` event, await the callback, emit
     `approval.resolved`, then proceed (`allow`) or push a `Denied` tool message
     (`deny`).
   - When `approvals` is **absent**, behaviour is byte-for-byte unchanged
     (current yolo/blocks logic). This keeps every existing experiment valid.
   - Add the two event types append-only in `events.ts`; do not rename or
     repurpose existing fields.
2. **Experiment** (`approval-experiment.ts`, bounded API): with a policy that
   returns `ask` for a mutating tool, run a real turn that calls that tool:
   (a) approval resolves `deny` → tool is blocked, model gets the denial;
   (b) approval resolves `allow` → tool executes and the file changes. Record
   the event sequence (`permission.decision` → `approval.requested` →
   `approval.resolved` → `tool.result`) and the resulting file bytes. This proves
   the loop truly pauses on the async callback.
3. **Server.** Store pending approvals in the runtime keyed by session +
   `toolCallId`. The turn's SSE emits `approval.requested`; add
   `POST /api/sessions/:id/approvals` `{ toolCallId, decision: "allow"|"deny",
   reason? }` that resolves the promise (404 unknown, 409 no turn waiting). Add a
   sane timeout that resolves `deny` so a turn can never hang forever, and record
   it in a comment.
4. **Web.** When an `approval.requested` event arrives mid-turn, show an
   Allow/Deny control that POSTs the decision; show the resolution when it
   arrives. Keep it minimal but real.

## Part 2 — Slash commands (secondary)

Show that a slash command is **input pre-processing**, not a model capability.

1. New self-contained `mechanisms/commands/`: a `CommandRegistry` +
   `parseCommand(input)` returning `{ name, args } | null`, plus built-ins:
   `/help`, `/memory <query>` (M9 `recall`), `/workers` (M10 supervisor
   snapshot), `/compact` (M3 `compactNow`). Each command returns either a
   synthetic reply or a message to inject **at the tail** (cache-safe: never
   rewrite the system prefix).
2. Server: intercept `input` beginning with `/` in `POST /api/sessions/:id/messages`
   **before** running a model turn when it matches a registered command; unknown
   commands fall through as normal input (or return a help hint — document the
   choice). Commands that inject context must append, not rewrite.
3. Docs: `docs/mechanisms/commands.md` teaches the registry + injection point.

## Constraints

- No new dependency. `.env` gitignored; never commit it.
- Unconfigured / no-command path must stay byte-for-byte unchanged.
- Additive-only to `events.ts`; keep `docs/CONTRACT.md` in sync with every new
  route/field.
- Bounded API calls; back off on 429.

## Ownership

The paths under Target. Do not edit the other `mechanisms/**` directories or
their experiment scripts.

## Observable acceptance

- `pnpm typecheck` green (4 packages) **and** `pnpm --filter @agent/web build` green.
- The approval experiment runs against the real model and shows deny vs allow
  with the recorded event order and file bytes.
- Via the server, a real `ask` produces an `approval.requested` SSE frame; POST
  allow executes, POST deny blocks; timeout denies.
- `/memory` and `/workers` and `/help` respond without a model turn; unknown
  slash input still reaches the model.
- `docs/runs/m12.md` + the two mechanism docs explain and measure it.
- Commit `M12: interactive approval + slash commands`.

## Finish protocol

Send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/runs/m12.md`. Then stop.
