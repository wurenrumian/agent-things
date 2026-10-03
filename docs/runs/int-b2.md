# 集成记录 — INT-B2：把 checkpoint（M6）与 scheduler（M7）接进 HTTP server

**日期**：2026-10-03
**模型**：`xiaomi/mimo-v2.6-flash`（OpenRouter）
**Target**：`packages/core/src/agent/loop.ts`、`packages/core/src/tools/registry.ts`、
`packages/core/src/events.ts`、`packages/server/src/**`、`apps/web/**`、
`docs/CONTRACT.md`、`docs/runs/int-b2.md`

> 目标：让 **M6 checkpoint** 与 **M7 scheduler** 从 HTTP server 真正可用、在观测台
> **可见**，且**默认惰性**——不写文件、不定任务时行为与之前逐字节一致。

## 0. 改了什么（一句话）

在 `ToolContext` 上开三个 additive 缝（`turnId` / `sessionId` / `checkpoints`）、在
`AgentConfig` 上加 `checkpoints`；loop 把三者透传给**每一次** `tool.execute`；
`events.ts` 新增 `task.settled` 事件（内联形状，不 import 机制类型）；server 打开
`CheckpointStore` 并**包装 `write_file`/`edit_file`**（执行前把 `input.path` 按
`ctx.cwd` 解析后快照进 `ctx.turnId`），创建 `Scheduler`，新增 4 条路由；web Timeline
渲染 `task.settled`。

## 1. 接线（代码）

| 位置 | 变化 |
|---|---|
| `tools/registry.ts` | `ToolContext` 增加可选 `turnId?` / `sessionId?` / `checkpoints?`（类型来自 `../mechanisms/checkpoint/index.js`） |
| `agent/loop.ts` | `AgentConfig` 增加 `checkpoints?`；`executeToolCall` 把 `turnId`、`this.sessionId`、`config.checkpoints` 传入 `tool.execute` 的 `ctx`。无其他 loop 改动 |
| `events.ts` | `AgentEvent` 新增 `task.settled` 变体（`{ taskId, name, kind:"one-shot"\|"interval", status, result?, error?, run, at }`），内联、不 import 机制类型 |
| `server/config.ts` | 新增 `CHECKPOINT_DIR`（缺省 `${DATA_DIR}/checkpoints`）、`SCHEDULER_ENABLED`（缺省 `true`，支持 `true/false/1/0/yes/no/on/off`） |
| `server/compose.ts` | `CheckpointStore.open(config.checkpointDir)`；`checkpointed()` 包装 `write_file`/`edit_file`（`await ctx.checkpoints?.snapshot(path.resolve(ctx.cwd, input.path), ctx.turnId)`）；`new Scheduler()`（`SCHEDULER_ENABLED` 为假则不建）；`agentConfig.checkpoints = store`；`close()` 里 `void scheduler?.shutdown()`；导出 `checkpoints` / `scheduler` |
| `server/index.ts` | Runtime 持有 `checkpoints`/`scheduler`；`scheduler.subscribe` 结算处理（回灌 + 落事件 + 持久化）；4 条路由（见 §2） |
| `apps/web` | `types.ts` 同步 `task.settled`；`TimelineTab` 渲染状态（`tl-status-succeeded/failed/cancelled`，`tl-task-settled` 紫色类型名）；`styles.css` 加配色 |
| `docs/CONTRACT.md` | 新事件、4 条路由、2 个 env、M6/M7 段落 |

> 观察故事：**未写文件 ⇒ 一个字节都没变**。checkpoint 包装只在 `write_file`/
> `edit_file` 上生效，循环透传的字段全部 optional；只读 turn 不产生任何快照。

## 2. 新增路由（详见 `docs/CONTRACT.md`）

```text
GET  /api/sessions/:id/checkpoints
       → { turns: [{ turnId, files: [{ path, existed, size, hash }] }] }
POST /api/sessions/:id/checkpoints/:turnId/restore
       → RestoreReport（sha256 判 identical）
POST /api/sessions/:id/schedule   { afterMs? | at? | intervalMs?, prompt }
       → TaskRecord（fresh nested Agent，settle 时回灌 + task.settled）
GET  /api/sessions/:id/tasks
       → TaskRecord[]（按会话过滤，任务名 = 会话 id）
```

## 3. 无配置运行（回归）— 行为不变（验收 3）

除 `SCHEDULER_ENABLED`/`CHECKPOINT_DIR` 外**什么都不配**，`:8795`。启动日志：

```text
[server] hooks: none (HOOKS_FILE unset)
[server] policy: none (POLICY_FILE unset)
[server] compaction: none (COMPACT_THRESHOLD_TOKENS unset/0)
[server] checkpoints: …\data\checkpoints
[server] scheduler: enabled
[server] skills: none …
[server] tools (6): edit_file, list_dir, read_file, run_shell, task, write_file
```

`node scripts/smoke.mjs "Read int-b2-target.txt with limit=2"` —— 与 INT-B1 记录的
形态一致：6 个工具、**没有任何 `mechanism` 事件**、权限仍是 `allow (mode=yolo)`：

```text
session: 7b1c90d3-986e-4081-a05b-afd423bfd01b
▶ turn.start
  context: messages=2 tools=[edit_file, list_dir, read_file, run_shell, task, write_file] estTokens=183
  assistant: tool_calls=1
  usage: prompt=899 completion=41 cached=0 cache_write=0
  → tool.call read_file {"path":"int-b2-target.txt","limit":2}
  permission: allow (mode=yolo)
  ← tool.result read_file isError=false dur=2ms
     1	ORIGINAL-CONTENT-INT-B2
  context: messages=4 tools=[…] estTokens=190
  assistant: tool_calls=0
■ turn.end stop
```

且该只读会话**没有任何 checkpoint turn**（惰性）：

```json
GET /api/sessions/7b1c90d3-…/checkpoints → { "turns": [] }
```

## 4. Checkpoint 验收（验收 1）

会话 `34de8de9-917a-4599-b070-cd59b960d3c3`，`AGENT_CWD=…/data/sandbox`。
预置 `int-b2-target.txt = "ORIGINAL-CONTENT-INT-B2"`，其 sha256：

```
83191b345505d66c84bb337e86bdee7a1c93deecc66466e1a603ef2d3e0f8b82
```

让模型 `write_file` 覆写它（`PERMISSION_MODE=yolo`）：

```text
▶ turn.start 34de8de9-…-t1
  → tool.call write_file {"path":"int-b2-target.txt","content":"CHANGED-BY-AGENT-INT-B2"}
  permission: allow
  ← tool.result write_file isError=false
■ turn.end stop
```

该 turn 记录了一条 checkpoint（快照的是**改之前**的字节）：

```json
GET /api/sessions/34de8de9-…/checkpoints →
{ "turns": [ { "turnId": "34de8de9-…-t1",
  "files": [ { "path": "…\\data\\sandbox\\int-b2-target.txt",
               "existed": true, "size": 23,
               "hash": "83191b345505d66c84bb337e86bdee7a1c93deecc66466e1a603ef2d3e0f8b82" } ] } ] }
```

磁盘内容已变为 agent 写的新文本（sha `b85f14a2…`）。随后**在磁盘上手工再改**
（sha `c0407867…`），再 restore：

```json
POST /api/sessions/34de8de9-…/checkpoints/34de8de9-…-t1/restore → 200
{ "turnId": "34de8de9-…-t1", "identical": true, "restored": 1, "deleted": 0,
  "entries": [ { "path": "…\\data\\sandbox\\int-b2-target.txt", "action": "restore",
                 "beforeHash": "c0407867d540b956fabc7ad4e477ad96aa598af8a98660cb97bb2a43ad4ad041",
                 "afterHash":  "83191b345505d66c84bb337e86bdee7a1c93deecc66466e1a603ef2d3e0f8b82",
                 "identical": true } ] }
```

落盘校验：内容回到 `ORIGINAL-CONTENT-INT-B2`，磁盘 sha256 再次等于快照
`83191b…`。**`RestoreReport.identical === true` 且磁盘 sha256 与快照一致（验收 1）**。

## 5. Scheduler 验收（验收 2）

新会话 `23e96f57-7a87-43a2-abe0-91bb00c8ba20`：

```json
POST /api/sessions/23e96f57-…/schedule { "afterMs": 300,
  "prompt": "Reply with exactly the single word READY and nothing else." } → 200
{ "id": "sched-musfn68x-1", "name": "23e96f57-…", "kind": "one-shot",
  "state": "scheduled", "runs": 0, "createdAt": 1791034408545, "nextRunAt": 1791034408845 }
```

等待约 20s（任务自身走了一次真实 nested `Agent` 调用）后，任务已结算：

```json
GET /api/sessions/23e96f57-…/tasks → 200
[ { "id": "sched-musfn68x-1", "name": "23e96f57-…", "kind": "one-shot",
    "state": "succeeded", "runs": 1, "lastStatus": "succeeded", "result": "READY",
    "lastStartedAt": 1791034408868, "lastFinishedAt": 1791034410129, "lastDurationMs": 1261 } ]
```

持久化的 `task.settled` 事件（seq 12）：

```json
GET /api/sessions/23e96f57-…/events →
{ "count": 1, "settled": [ { "seq": 12, "event": {
  "type": "task.settled", "taskId": "sched-musfn68x-1", "name": "23e96f57-…",
  "kind": "one-shot", "status": "succeeded", "result": "READY", "run": 1,
  "at": 1791034410138 } } ] }
```

回灌进会话消息数组（`reinjectTaskOutcome`，`role:"user"`）：

```json
GET /api/sessions/23e96f57-… →
{ "session": { …, "messageCount": 1 },
  "messages": [ { "role": "user", "content":
    "[background task succeeded] id=sched-musfn68x-1 name=\"23e96f57-…\" (one-shot, run 1, 1261ms)\n\nResult:\nREADY\n\nThis task ran outside the current turn. If the user is waiting on it, summarize the result now; otherwise fold it into your next reply." } ] }
```

**`task.settled` 事件已持久化 + 一条 re-injected user 消息在会话消息里（验收 2）**。

## 6. Web

`TimelineTab` 现在把 `task.settled` 按 `status` 着色：`succeeded` 绿、
`failed` 红、`cancelled` 琥珀，类型名紫色（`.tl-task-settled` / `.tl-status-*`），
brief 显示 `status · name (kind, run N)`。`mechanism` 事件本就渲染。其余 tab 不受影响。

## 7. 约束遵守

- **不加依赖**：只用 Node 内置 + 已有 core 机制代码。
- **默认惰性**：`checkpoints` 只在 `write_file`/`edit_file` 前置快照；只读 turn 无
  `mechanism` 事件、无 checkpoint turn、权限仍 `allow (mode=yolo)`。
- `SCHEDULER_ENABLED=false` 时 `POST …/schedule` 返回 `409`、`GET …/tasks` 为空。
- `pnpm typecheck` 全包 green；`pnpm --filter @agent/web build` green。
- `.env` 从 `D:/Project/agent-things/.env` 复制到 `./.env`（`.gitignore` 覆盖，未提交）；
  demo fixture 放在 gitignored 的 `data/int-b2/`。

## 8. 复现

```bash
cp D:/Project/agent-things/.env ./.env          # gitignored
pnpm install
pnpm typecheck
pnpm --filter @agent/web build

$env:PORT='8795'; pnpm --filter @agent/server start

# checkpoint
node data/int-b2/probe.mjs new "int-b2-checkpoint"          # 记下 <ckSession>
# 预置 data/sandbox/int-b2-target.txt 后：
node data/int-b2/probe.mjs turn <ckSession> "Call write_file once path=int-b2-target.txt content=CHANGED-BY-AGENT-INT-B2"
node data/int-b2/probe.mjs checkpoints <ckSession>
node data/int-b2/probe.mjs restore <ckSession> <ckSession>-t1

# scheduler
node data/int-b2/probe.mjs new "int-b2-scheduler"           # 记下 <schedSession>
node data/int-b2/probe.mjs schedule <schedSession> 300 "Reply with exactly the single word READY and nothing else."
node data/int-b2/probe.mjs tasks <schedSession>
node data/int-b2/probe.mjs events <schedSession>
node data/int-b2/probe.mjs session <schedSession>
```

代码位置：`packages/core/src/tools/registry.ts`（ToolContext 缝）、
`packages/core/src/agent/loop.ts`（透传）、`packages/core/src/events.ts`
（`task.settled`）、`packages/server/src/compose.ts`（store + scheduler + 包装）、
`packages/server/src/index.ts`（4 路由 + 结算处理）、
`apps/web/src/components/TimelineTab.tsx` / `types.ts` / `styles.css`。
