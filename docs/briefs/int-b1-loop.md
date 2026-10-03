# Worker brief — INT-B1: hooks/permissions + compaction in the loop

Like INT-A, this task **edits shared files**: `packages/core/src/agent/loop.ts`,
`packages/core/src/events.ts`, `packages/core/src/permissions.ts`,
`packages/server/src/**`, `apps/web/**`, `docs/CONTRACT.md`. Single worker, no
sibling, so no conflict.

## Goal

Make the **M6 hooks/permissions** and **M3 compaction** mechanisms actually
drive the agent loop, observable in the observatory, and **off by default**
(behavior unchanged when unconfigured).

## Read first

- `docs/mechanisms/permissions.md`, `docs/mechanisms/compaction.md`
- `packages/core/src/agent/loop.ts`, `events.ts`, `permissions.ts`
- `packages/core/src/mechanisms/hooks/{index,types,decide,runner,policy,config}.ts`
- `packages/core/src/mechanisms/compaction/{index,compact,clear-tool-results}.ts`
- `packages/server/src/{config,compose,index}.ts`, `docs/CONTRACT.md`, `docs/runs/int-a.md`

## Change

### 1. Core seams (additive)

**`events.ts`**
- `PermissionDecision` becomes `"allow" | "deny" | "ask"`.

**`loop.ts` — `AgentConfig` gains three optional hooks**
- `gate?: (req: { tool: string; input: Record<string, unknown>; turnId: string })
  => Promise<{ decision: "allow" | "deny" | "ask"; reason: string;
  input: Record<string, unknown> }>`
  When set, it replaces `decidePermission(mode, tool)` for the tool gate. The
  returned `input` is what the tool is executed with (hook mutations).
- `hooks?: HookRunner` — drives the **text** lifecycle points:
  `userPromptSubmit` (rewrite the turn input before it is pushed) and
  `preCompact` (extra instructions for the summarizer).
- `compaction?: { thresholdTokens: number;
  compact(messages: ChatMessage[]): Promise<{ messages: ChatMessage[];
  info: Record<string, unknown> }> }`
  At the **top of each step**, if set and `estimateTokens(history) >
  thresholdTokens`, call `compact()`, replace `this.messages`, and emit a
  `mechanism` event. At most once per step.

**`executeToolCall`**
- Use `config.gate` when present; else keep `decidePermission`.
- Emit `permission.decision` with the (possibly `"ask"`) decision + reason.
- Execution rule: `deny` → block; `ask` → **proceed only when
  `permissionMode === "yolo"`**, otherwise block with a "pending approval
  (non-interactive)" reason. The event always records the true verdict.
- Execute with the gate-returned `input`.
- After the tool, if `hooks` is set, run `postToolUse` (observational; append a
  `mechanism` event with the records; do not alter `output`).
- Every hook/compaction run emits `mechanism` events (`skills` style), e.g.
  `{ type:"mechanism", name:"hooks", phase:"preToolUse", data:{ records } }`
  and `{ ..., name:"compaction", phase:"compacted", data:{ before, after,
  summarized, placement } }`. These ride the existing `ToolResult.events` /
  direct-yield paths.

### 2. Server wiring

- `config.ts` (additive): `HOOKS_FILE`, `POLICY_FILE` (paths; absent = off),
  `COMPACT_THRESHOLD_TOKENS` (0/absent = off), `COMPACT_KEEP_RECENT` (8),
  `COMPACT_KEEP_LEADING` (1), `COMPACT_PLACEMENT` (`spliced`).
- `compose.ts`: when configured, build `HookRunner` (+ `Policy`) and a `gate`
  that calls `decide(policy, hooks, req)`; map `kind`→`decision`. Build a
  `compact` fn from `compactDetailed` whose `summarize` calls the model
  (reuse `client`; accumulate `chatStream` if there is no non-stream call).
  Keep everything absent ⇒ the current five-tool, no-hook path unchanged.
- Route (additive to `docs/CONTRACT.md`):
  `POST /api/sessions/:id/compact` → force compaction of the live agent's
  messages now; persist; return
  `{ before, after, summarized, keptRecent, keptLeading, placement }`.

### 3. Web

- Render `permission.decision` `"ask"` distinctly (Timeline); `mechanism`
  events already render. Do not break existing tabs.

### 4. Docs

- Update `docs/CONTRACT.md` (new event verdict, new route, new env).
- Write `docs/runs/int-b1.md` with evidence.

## Constraints

- Add **no dependencies**.
- Unconfigured ⇒ byte-for-byte the current behavior (smoke path).
- Do **not** touch checkpoint or scheduler (INT-B2).
- `pnpm typecheck` green + `pnpm --filter @agent/web build` green.

## Observable acceptance

- No config: smoke turn completes exactly as before.
- `POLICY_FILE` with a deny rule + `HOOKS_FILE` with a mutate hook: a turn shows
  the true verdict (`deny`/`ask`) and runs the **mutated** input; `postToolUse`
  records appear.
- `COMPACT_THRESHOLD_TOKENS` small: a long turn emits `compaction/compacted`,
  the live `prompt` token estimate drops, and `POST /api/sessions/:id/compact`
  works.
- `docs/runs/int-b1.md` captures the evidence; commit
  `INT-B1: hooks/permissions + compaction in the loop` (do not push).

## Finish protocol

`worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/runs/int-b1.md`. Then stop.
