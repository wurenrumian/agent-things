# L3 — Labs (run report)

**Goal.** Turn the observatory into a teaching instrument: a **Labs** tab that
catalogs every `packages/server/scripts/*-experiment.ts` harness and runs it with
the output streaming live. Reuse the scripts; add no dependency; keep the rest of
the server byte-for-byte unchanged when labs are disabled.

**Outcome.** Implemented and verified end-to-end. `pnpm typecheck` (4 packages)
and `pnpm --filter @agent/web build` are green; `GET /api/labs` returns the full
12-lab catalog; the offline `forensics` lab streams its classifier table and
exits `0`; a concurrent second run returns `409`; unknown id returns `404`;
`LABS_ENABLED=false` makes the routes inert while the rest of the server is
unchanged. Committed as `L3: labs`.

## What changed

- `packages/server/src/labs/types.ts` (new) — `Lab`, `LabKind`, `LabFrame`.
- `packages/server/src/labs/registry.ts` (new) — the 12-entry **allowlist**.
- `packages/server/src/labs/runner.ts` (new) — spawn + line-framed stream,
  tree-kill timeout, client-disconnect kill, one-at-a-time gate.
- `packages/server/src/config.ts` — `LABS_ENABLED` (default `true`),
  `LAB_TIMEOUT_MS` (default `300000`).
- `packages/server/src/index.ts` — `GET /api/labs`, `POST /api/labs/:id/run`.
- `apps/web/src/components/LabsTab.tsx` (new) + `Observatory.tsx`, `api.ts`,
  `types.ts`, `styles.css` — the Labs tab, catalog + confirm + live console.
- `docs/CONTRACT.md` — new routes, new env, Labs tab note.
- `docs/labs.md` (new) — design teaching doc + "how to add a lab".
- `docs/runs/l3-labs.md` (new) — this report.

Scripts under `packages/server/scripts/**` and `docs/runs/*.md` other than this
one were **read only, not edited**.

## Catalog (`GET /api/labs`)

Observed (server on `:8797`, `.env` `AGENT_CWD=./data/sandbox`):

```
enabled=True count=12
id           kind    apiCalls
cache        api            5
forensics    offline
skills       api           12
compaction   api           21
mcp          api           20
subagent     api           10
hooks        offline
scheduler    offline
memory       api           30
orchestrator api           20
tool-search  api           30
approval     api            5
```

Three offline labs (`forensics`, `hooks`, `scheduler`) match the scripts' own
"zero API / no model calls" headers; the other nine state a call budget in their
header, surfaced as `apiCalls`.

## Forensics run, streamed (`POST /api/labs/forensics/run`)

Frame histogram observed on the wire:

```
frame types {"start":1,"stdout":13,"stderr":2,"exit":1}
exit  data: {"type":"exit","code":0,"durationMs":215}
start data: {"type":"start","id":"forensics","command":"D:\\nodejs\\node.exe D:\\Project\\agent-things\\l3-labs\\node_modules\\.pnpm\\tsx@4.23.15\\node_modules\\tsx\\dist\\cli.mjs D:\\Project\\agent-things\\l3-labs\\packages\\server\\scripts\\forensics-experiment.ts"}
```

The streamed `stdout` includes the classifier table and the summary:

```
#  case                                    expected    actual  verdict  detail
-  --------------------------------------  --------  --------  -------  -----------------------------------------
1  identical bodies                            none      none     PASS  none · no change anywhere
2  tools reversed                             tools     tools     PASS  tools · reordered: true
3  one tool added (fetch_url)                 tools     tools     PASS  tools · added: ["fetch_url"]
4  system changed 1 byte                     system    system     PASS  system · changedAt set
5  append-only messages                        none      none     PASS  none · messages.appended > 0
6  tools identical, middle message edited  messages  messages     PASS  messages · changedAt > 0, prefix survives

ALL PASS — 6/6 cases
```

and an `exit` frame with code `0`.

## Concurrency (409)

With a long offline lab (`scheduler`, ~6s) holding the slot, a second request to
`forensics`:

```
second status 409 body {"error":"busy","message":"a lab is already running"}
first status 200 has exit true
unknown status 404 {"error":"lab not found"}
```

The slot is reserved before the SSE stream opens, so the busy case is a real
`409` JSON response, not an empty stream.

## `LABS_ENABLED=false` (server unchanged)

A second server started with `LABS_ENABLED=false` on `:8798`:

```
GET  /api/labs            -> 200 {"enabled":false,"labs":[]}
POST /api/labs/forensics/run -> 403 {"error":"labs are disabled (LABS_ENABLED=false)"}
GET  /api/health          -> 200 {"ok":true,"model":"xiaomi/mimo-v2.6-flash"}
GET  /api/sessions        -> 200
GET  /api/mechanisms      -> 200 keys skills,mcpServers,tools,memory,orchestrator,toolSearch
```

## Browser path (Vite proxy 5173 → 8787)

The exact path the Labs tab uses:

```
page status 200 content-type text/html
proxied /api/labs status 200 enabled true count 12
proxied run status 200 exit data: {"type":"exit","code":0,"durationMs":334}
proxied run table+pass true
```

## Bugs found and fixed during validation

1. **`tsx` CLI resolution under pnpm.** `require.resolve("tsx/dist/cli.mjs")`
   throws because the package's `exports` map blocks that subpath, and the naive
   fallback `node_modules/tsx/...` does not exist under pnpm's `.pnpm` layout.
   Fixed by resolving `tsx/package.json` and reading its `bin` field.
2. **Dropped terminal frame.** The runner loop `while(!closed)` could exit after
   `start` if the child finished during the `yield`, discarding the buffered
   `exit` frame. Fixed to `while(!closed || queue.length > 0)`.
3. **Spawn ENOENT from a missing cwd.** Running the child from `AGENT_CWD`
   (`./data/sandbox`, not yet created) made `spawn` fail with ENOENT. Fixed by
   running experiments from the repo root, which their relative imports and
   `.env` discovery assume.
4. **Busy reported on the stream, not as 409.** Initially the busy case was an
   SSE `error` frame. Refactored `LabRunner` to reserve the slot before
   `streamSSE`, giving a real `409`.

## Acceptance checklist

| Check | Result |
|---|---|
| `pnpm typecheck` (4 packages) | green |
| `pnpm --filter @agent/web build` | green |
| `GET /api/labs` catalog (~12, correct kind/apiCalls) | 12, 3 offline / 9 api |
| `POST /api/labs/forensics/run` streams table + exit 0 | yes (`ALL PASS — 6/6`) |
| Second concurrent run | `409 {"error":"busy"}` |
| Unknown id | `404` |
| `LABS_ENABLED=false` routes inert, rest unchanged | `403` / `{enabled:false}` |
| Web Labs tab renders catalog + live console | bundle verified; proxy run exit 0 |
| `docs/labs.md` + `docs/runs/l3-labs.md` | written |
| Commit `L3: labs` | done |
