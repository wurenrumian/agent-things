# Labs — experiments as a teaching instrument

Before this layer a learner had to drop to a terminal and remember the exact
invocation:

```bash
pnpm --filter @agent/server exec tsx scripts/forensics-experiment.ts
```

That is fine for the author of the repo but hostile to anyone trying to *learn*
from it. **Labs** turns the observatory into a teaching instrument: a **Labs**
tab catalogs every experiment, explains what each one proves, and runs it with
the output streaming live — no terminal, no remembered path. The experiments
themselves are reused verbatim; this layer is a launcher, not a rewrite.

## The three pieces

| File | Role |
|---|---|
| `packages/server/src/labs/types.ts` | `Lab`, `LabKind`, `LabFrame` — the shared shapes |
| `packages/server/src/labs/registry.ts` | the **allowlist**: one entry per experiment script |
| `packages/server/src/labs/runner.ts` | spawn + stream + timeout/kill + one-at-a-time gate |
| `packages/server/src/index.ts` | `GET /api/labs`, `POST /api/labs/:id/run` (`streamSSE`) |
| `apps/web/src/components/LabsTab.tsx` | the tab: catalog, confirm, live console |

## 1. The allowlist (registry)

The single most important design decision: **the server never accepts a path
from the caller.** `POST /api/labs/:id/run` resolves the id against `LABS`, and
the only thing that ever reaches `spawn()` is the `script` field of a registry
entry. An unknown id is a `404`, not a file read. This makes the endpoint safe
to expose without a validation layer, and it makes the catalog the single source
of truth for "what can be run".

Each `Lab` carries everything the UI needs to be honest about cost:

```ts
interface Lab {
  id: string;            // stable slug, the URL segment
  title: string;
  mechanism: string;     // cache, skills, hooks, …
  kind: "offline" | "api";
  apiCalls?: number;     // the harness's own stated call budget
  estSeconds?: number;
  script: string;        // allowlisted file under packages/server/scripts/
  docsRun: string;       // the recorded evidence, docs/runs/*.md
  blurb: string;
}
```

`kind: "offline"` means the harness is pure `@agent/core` + `node:` built-ins —
no `.env`, no network. Three labs qualify (`forensics`, `hooks`, `scheduler`);
the other nine talk to OpenRouter and carry an `apiCalls` budget taken from each
script's own header comment.

## 2. The runner (child process + streamed ledger)

`LabRunner` spawns the script and converts `stdout`/`stderr` into a stream of
frames. Four guards matter:

**Portable launch.** `tsx` is invoked through the *current* `node` executable
(`process.execPath`) on the resolved `tsx` CLI JS entry — never a `.cmd` shim, so
it works identically on Windows and POSIX. The CLI entry is found by resolving
`tsx/package.json` and reading its `bin` field; pnpm's symlinked layout makes a
naive `node_modules/tsx/...` path wrong, and the package's `exports` map blocks
a direct `tsx/dist/cli.mjs` subpath.

**Environment passthrough.** The child inherits `process.env`, so the repo-root
`.env` that the server loaded at boot is available to API labs. No key is ever
copied into the catalog or the web bundle.

**Timeout kills the tree.** `LAB_TIMEOUT_MS` (default `300000`) starts a timer;
on expiry the whole process **tree** is killed (`taskkill /T /F` on Windows,
`kill(-pid)` on POSIX) and the run emits `{ type:"exit", timedOut:true }`. A
single `tsx` run spawns a child of its own, so killing only the direct child
would leak the real experiment.

**One at a time.** `LabRunner.acquire()` reserves a single slot. The route
reserves it *before* opening the stream, so a concurrent request gets a real
`409 { error:"busy" }` JSON response rather than a silently empty SSE stream.
The slot is released in a `finally`, on every path including client disconnect.

The frame protocol is deliberately tiny:

```
{ type: "start",  id, command }          // once, announces the child
{ type: "stdout", line }                 // one line per frame
{ type: "stderr", line }
{ type: "exit",   code, durationMs, timedOut?, error? }   // terminal
```

Line framing is done with an incremental splitter (`LineBuffer`) so a chunk that
ends mid-line is buffered until the rest arrives; the tail is flushed on close.

### The race worth naming

The generator yields `start` and then suspends. During that suspension the child
can already have finished and pushed its `exit` frame. A loop of the shape
`while (!closed) { … }` then exits **without draining the queue**, silently
dropping the terminal frame. The loop must run while `!closed || queue.length > 0`
so buffered frames are always delivered before the generator ends.

## 3. Routes

```jsonc
GET  /api/labs            -> { enabled, labs: Lab[] }
POST /api/labs/:id/run    -> text/event-stream of LabFrame
```

Statuses: `404` unknown id, `403` when `LABS_ENABLED=false`, `409` busy.

## 4. The web tab

`LabsTab` fetches the catalog once, groups it by `kind` (offline first), and
renders each entry with its title, blurb, mechanism, `apiCalls` and a `docsRun`
link. Running an `api` lab first shows a `window.confirm` that restates the
budget — the learner sees the cost before spending it. A run renders a live
console with tinted `stderr` and the exit status/duration; the **Kill** button
aborts the `AbortController`, which closes the connection and makes the server
kill the process tree. Nothing runs on page load.

## 5. How to add a lab

1. Write the harness under `packages/server/scripts/<name>-experiment.ts` (or
   reuse an existing one — do not edit them from this layer).
2. Add one entry to `LABS` in `registry.ts`: id, title, mechanism, `kind`,
   `apiCalls`/`estSeconds`, `script`, `docsRun`, and a one-line blurb.
3. Point `docsRun` at the recorded run for the mechanism.
4. `pnpm typecheck`; the lab now appears in `GET /api/labs` and the tab.

No route or UI change is needed — the catalog drives everything.

## Reading map

- `packages/server/src/labs/registry.ts` — the allowlist and the catalog.
- `packages/server/src/labs/runner.ts` — spawn, line framing, kill, busy gate.
- `packages/server/src/labs/types.ts` — the frame and catalog types.
- `apps/web/src/components/LabsTab.tsx` — the tab and its live console.
- `docs/runs/l3-labs.md` — the boot/route evidence for this layer.
- `docs/CONTRACT.md` §"L3 Labs" — the frozen HTTP contract.
