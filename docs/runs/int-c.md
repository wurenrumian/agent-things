# 集成记录 — INT-C：把 M9 memory / M10 orchestrator / M11 tool-search 接进 server + web

**日期**：2026-10-04
**模型**：`xiaomi/mimo-v2.6-flash`（OpenRouter）
**Target**：`packages/server/src/{config,compose,index}.ts`、`apps/web/**`（最小读出口）、
`docs/{CONTRACT,ROADMAP,MECHANISMS,STATE}.md`、`README.md`、本文件

> 目标：在 master（已合入 M9 `1c04efe` / M10 `392888f` / M11 `8eac7ab`）之上，
> 把三个机制按仓库 INT 模式接进组装根与 HTTP 层。**核心不变式：所有新 env 未设置时
> 行为逐字节不变。** 不触碰机制目录与其实验脚本，不新增依赖。

## 0. 改了什么（一句话）

`config.ts` 新增 6 个 env；`compose.ts` 按开关注册 `memory` 工具、`Supervisor` +
5 个编排工具、以及在**最外层**用 `createToolSearchRegistry` 包裹完整 registry；
`index.ts` 新增 `GET /api/memories`、`GET /api/workers` 并扩展 `GET /api/mechanisms`；
web 的 Mechanisms 条带增加 memory / workers / tool search 读出口；文档回填实测。

## 1. 接线表

| 位置 | 变化 |
|---|---|
| `config.ts` | `MEMORY_ENABLED`(bool,false) / `MEMORY_DIR`(默认 `${DATA_DIR}/memory`) / `MEMORY_SYSTEM_INJECT`(bool,false) / `ORCHESTRATOR_ENABLED`(bool,false) / `ORCHESTRATOR_MAX_WORKERS`(正整数,4) / `TOOL_SEARCH_ENABLED`(bool,false) |
| `compose.ts` | memory：`MemoryStore.open` + `createMemoryTool`（包 `observable`，事件名 `memory`）；可选 system 尾部注入；暴露**活的** `memories:{dir,count,entries,systemInject}`。orchestrator：`new Supervisor(...)` + `createOrchestratorTools`（包 `observable`，事件名 `orchestrator`）；宿主侧包 `spawn_worker` 限流；`close()` 里 `stopAll()` + `dispose()`。tool-search：所有注册完成后 `createToolSearchRegistry(tools)`，`agentConfig.tools` 指向门面 |
| `index.ts` | `Runtime` 增 `memories?` / `supervisor?` / `toolSearchEnabled`；`GET /api/mechanisms` 增 `memory`/`orchestrator`/`toolSearch`；新增 `GET /api/memories`、`GET /api/workers`（未启用返回 `{enabled:false}`） |
| `apps/web` | `types.ts` `Mechanisms` 增三个可选状态；`Observatory.tsx` MechanismStrip 增 memory / workers / tool search 读出口 |
| `events.ts` | **未改**——复用既有 `mechanism` 事件与 `ToolResult.events`（brief §4） |
| docs | `CONTRACT.md`（env + 三路由 + M9/M10/M11 说明）、`ROADMAP.md`、`MECHANISMS.md §7`、`STATE.md`、`README.md` |

## 2. flags 全关（回归）— 行为不变

`MEMORY_ENABLED` / `ORCHESTRATOR_ENABLED` / `TOOL_SEARCH_ENABLED` 均未设置，PORT=8791：

```
[server] memory: disabled (MEMORY_ENABLED unset/false)
[server] orchestrator: disabled (ORCHESTRATOR_ENABLED unset/false)
[server] tools (6): edit_file, list_dir, read_file, run_shell, task, write_file
[server] listening on http://localhost:8791 ...
```

```
GET /api/config     → tools: [edit_file, list_dir, read_file, run_shell, task, write_file]
GET /api/mechanisms → { skills:[], mcpServers:[], tools:[6 个],
                        memory:{enabled:false}, orchestrator:{enabled:false,workers:0},
                        toolSearch:{enabled:false} }
GET /api/memories   → { "enabled": false }
GET /api/workers    → { "enabled": false }
```

工具集合与顺序与 INT-A/INT-B 完全一致（6 个 = 5 builtin + `task`）——**不变式成立**。

## 3. flags 全开

`MEMORY_ENABLED=true`、`MEMORY_DIR=./data/int-c-on/memory`、
`ORCHESTRATOR_ENABLED=true`、`ORCHESTRATOR_MAX_WORKERS=4`、`TOOL_SEARCH_ENABLED=true`，
PORT=8792：

```
[server] memory: enabled (dir=...\data\int-c-on\memory, entries=0, systemInject=false)
[server] orchestrator: enabled (maxWorkers=4)
[server] tools (12): edit_file, list_dir, list_workers, memory, read_file, run_shell,
                     send_message, spawn_worker, stop_worker, task, wait_for, write_file
[server] tool-search: enabled (12 real tools behind tool_call, tool_search)
[server] listening on http://localhost:8792 ...
```

```
GET /api/config     → tools: ["tool_call","tool_search"]        # 验收：只列门面两个
GET /api/mechanisms → memory:{enabled:true,dir:...,count:0,systemInject:false},
                      orchestrator:{enabled:true,workers:0}, toolSearch:{enabled:true}
GET /api/memories   → { enabled:true, dir:..., count:0, systemInject:false, entries:[] }
GET /api/workers    → { enabled:true, coordinatorId:"coordinator", workers:[],
                        reports:[], usage:{calls:0,...}, pending:[] }
```

## 4. 真实 turn 调用 `memory`（验收主证据）

只开 `MEMORY_ENABLED=true`（TOOL_SEARCH 关，模型可直接看到 `memory`），
PORT=8793。新建 session 后 POST 一条消息，要求模型调用 `memory(action=save)`：

```
SESSION: da6326f9-df44-4d9d-85ab-17c5e487820d
[server] tools (7): edit_file, list_dir, memory, read_file, run_shell, task, write_file

GET /api/memories →
{
  "enabled": true,
  "dir": "...\\data\\int-c-turn\\memory",
  "count": 1,
  "systemInject": false,
  "entries": [
    { "id": "mem_mutfwvm8_1_zl7oqz",
      "text": "INT-C acceptance memory: a real turn reached the M9 store.",
      "createdAt": 1791095327504,
      "tags": ["int-c","acceptance"] }
  ]
}
```

条目只可能来自 `memory` 工具把结果落在**消息尾部**；`count`/`entries` 是活 getter，
turn 结束后无需重启即读到。M9 机制本身的跨会话/缓存结论见
[`m9-memory.md`](m9-memory.md)（尾部注入 `cached` 3584→3584 vs 前缀改写 3648→0）。

## 5. `MEMORY_SYSTEM_INJECT=true` 启动路径

复用上一步的存储目录，PORT=8794：

```
[server] memory: enabled (dir=...\data\int-c-turn\memory, entries=1, systemInject=true)
[server] memory: system injection on (suffix chars=162)
GET /api/mechanisms → memory:{enabled:true,dir:...,count:1,systemInject:true}
```

注入用导出的 `buildSystemPrompt({cwd,platform})` 拼 `memorySystemSuffix(store.all())`，
追加在 system **最末端**（M2 §c′ / M9 §4 的 append-safe 位置）；该块在启动时冻结，
默认关闭。

## 6. web 读出口

`pnpm --filter @agent/web build` green（42 modules，`dist/assets/index-*.js` 168.83 kB）。
MechanismStrip 现在额外显示：`memory`（启用时 `N entries[ · sys]`，否则 `off`）、
`workers`（启用时计数，否则 `off`）、`tool search`（`on`/`off`），数据来自扩展后的
`GET /api/mechanisms`。

## 7. 文档回填

- `CONTRACT.md`：6 个 env + `GET /api/memories` / `GET /api/workers` + M9/M10/M11 段落。
- `ROADMAP.md`：当前进度勾选 INT-C；v2 表 M9/M10/M11 状态 → `INT-C ✅`。
- `MECHANISMS.md §7`：新增 M9/M10/M11 实测小节（回填各自 run doc）。
- `STATE.md` / `README.md`：v2 状态、机制表新增三行（含 env 开关）。

## 8. 约束遵守

- **未新增依赖**：memory/orchestrator/tool-search 复用既有机制，无新包。
- **未触碰** `packages/core/src/mechanisms/{memory,orchestrator,tool-search}/**`、
  `packages/server/scripts/*-experiment.ts`、`docs/briefs/**`。
- `.env` 从主 worktree 复制（gitignored，未提交）。
- `pnpm typecheck` 四包全绿（core / server / web / cli）。
- API 调用：仅第 4 节 1 次真实 turn（budget ≤ 2），未触发 429。
- 不变式：§2 证明全关时工具集合/行为与之前一致。

## 9. 复现

```bash
cp D:/Project/agent-things/.env ./.env      # gitignored
pnpm install
pnpm typecheck
pnpm --filter @agent/web build

# flags off（回归）
$env:PORT='8791'; $env:DATA_DIR='./data/int-c-off'
pnpm --filter @agent/server start
# GET /api/config, /api/memories, /api/workers

# flags on
$env:PORT='8792'; $env:DATA_DIR='./data/int-c-on'
$env:MEMORY_ENABLED='true'; $env:ORCHESTRATOR_ENABLED='true'; $env:TOOL_SEARCH_ENABLED='true'
pnpm --filter @agent/server start
# GET /api/config → ["tool_call","tool_search"]
```

代码位置：`packages/server/src/config.ts`、`compose.ts`（组装根）、`index.ts`（路由）、
`apps/web/src/components/Observatory.tsx` + `types.ts`。
