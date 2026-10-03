# 集成记录 — INT-A：把 skills / MCP / subagent 接进 HTTP server

**日期**：2026-10-03
**模型**：`xiaomi/mimo-v2.6-flash`（OpenRouter）
**Target**：`packages/core/src/events.ts`、`packages/core/src/tools/registry.ts`、
`packages/core/src/agent/loop.ts`、`packages/server/src/**`、`apps/web/**`、
`docs/CONTRACT.md`、`docs/runs/int-a.md`

> 目标：让 M2（skills）、M4（MCP）、M5（subagent）三个**工具形态的机制**在 HTTP
> server 里真正可用，并在观测台里可见；同时保证「什么都不配」时行为不变。

## 0. 改了什么（一句话）

新增一条 additive 事件缝 `mechanism` + `ToolResult.events`：机制工具把进度挂到
`ToolResult.events`，`loop` 在 `tool.result` 之后原样 yield；新增组装根
`packages/server/src/compose.ts`，按配置注册 builtin + `use_skill` + MCP + `task`；
新增 `GET /api/mechanisms` 与 web 端 Mechanisms 条带 / Timeline 渲染。

## 1. 接线（代码）

| 位置 | 变化 |
|---|---|
| `events.ts` | `AgentEvent` 增加 `{ type:"mechanism"; name; phase; data?; at }` |
| `tools/registry.ts` | `ToolResult` 增加可选 `events?: AgentEvent[]` |
| `agent/loop.ts` | `executeToolCall` 收集 `result.events`，在 `tool.result` 后按序 yield |
| `server/src/config.ts` | 新增 `SKILLS_DIR`（默认 `./skills`）、`MCP_SERVERS`（JSON，默认 `[]`）、`SUBAGENT_MAX_STEPS`（默认 `12`） |
| `server/src/compose.ts` | 组装根：builtin + `use_skill` + MCP + `task`；每个机制工具包一层，产出 `mechanism` 事件；MCP 连接失败只告警不致命；`close()` 关闭 MCP 子进程 |
| `server/src/index.ts` | 用 `composeAgent` 替换内联注册；新增 `GET /api/mechanisms`；SIGINT/SIGTERM 优雅关闭 |
| `apps/web` | Timeline 渲染 `mechanism`；Observatory 增加 Mechanisms 条带（skills / mcp / tools） |
| `docs/CONTRACT.md` | 新增路由、`mechanism` 事件、三个 env |

## 2. 配置齐全的运行（skills + MCP）— 验收主证据

`SKILLS_DIR` 指向内置 fixture，`MCP_SERVERS` 指向内置 echo MCP server：

```
MCP_SERVERS=[{"name":"echo","command":"D:\\nodejs\\node.exe","args":["packages/core/src/mechanisms/mcp/fixtures/echo-server.mjs"]}]
PORT=8789
```

### 2.1 启动日志

```
[server] skills: 2 loaded from D:\Project\agent-things\int-a-tools\packages\core\src\mechanisms\skills\fixtures\skills (code-review, release-notes)
[server] mcp "echo": 2 tool(s) (echo_1, echo_2)
[server] tools (9): echo_1, echo_2, edit_file, list_dir, read_file, run_shell, task, use_skill, write_file
[server] listening on http://localhost:8789 (model: xiaomi/mimo-v2.6-flash, cwd: ...\data\sandbox, db: ...\data\agent.db)
```

### 2.2 `GET /api/config` — `use_skill` 与 `task` 都在

```json
{
  "model": "xiaomi/mimo-v2.6-flash",
  "cwd": "D:\\Project\\agent-things\\int-a-tools\\data\\sandbox",
  "permissionMode": "yolo",
  "tools": [
    "echo_1", "echo_2", "edit_file", "list_dir", "read_file",
    "run_shell", "task", "use_skill", "write_file"
  ]
}
```

### 2.3 `GET /api/mechanisms` — 加载的 skills / servers / tools

```json
{
  "skills": ["code-review", "release-notes"],
  "mcpServers": ["echo"],
  "tools": [
    "echo_1", "echo_2", "edit_file", "list_dir", "read_file",
    "run_shell", "task", "use_skill", "write_file"
  ]
}
```

### 2.4 `mechanism` 事件端到端（SSE + 持久化）

一次真实 turn：让模型调用 `use_skill(code-review)`。SSE 上看到 `tool.result`
之后紧跟一条 `mechanism`，事件日志里也持久化了同一条：

```
tool.call use_skill {"name":"code-review"}
tool.result use_skill isError=false out="\r\n# Code review\r\n..."
MECHANISM {"type":"mechanism","name":"skills","phase":"loaded","data":{"skill":"code-review"},"at":1791032649972}
turn.end stop
stored mechanism events: 1
stored {"type":"mechanism","name":"skills","phase":"loaded","data":{"skill":"code-review"},"at":1791032649972}
```

## 3. 什么都不配置的运行（回归）— 行为不变

`SKILLS_DIR=data/no-skills`（不存在）、`MCP_SERVERS=[]`、`PORT=8790`：

```
[server] skills: none in ...\data\no-skills
[server] tools (6): edit_file, list_dir, read_file, run_shell, task, write_file
[server] listening on http://localhost:8790 ...
```

`GET /api/mechanisms` → `{ "skills": [], "mcpServers": [], "tools": [五个 builtin + task] }`。

smoke turn（builtin `read_file` 读文件后收尾）完整跑通：

```
context: messages=2 tools=[edit_file, list_dir, read_file, run_shell, task, write_file] estTokens=185
→ tool.call read_file {"path":"greet.mjs"}
permission: allow (mode=yolo)
← tool.result read_file isError=false dur=3ms
context: messages=4 tools=[...] estTokens=222
usage: prompt=976 completion=20 cached=896 cache_write=0
■ turn.end stop
```

> 说明：五个 builtin 工具行为不变。`task`（subagent）不需要任何外部配置，因此始终
> 注册；`use_skill` 仅在 `SKILLS_DIR` 含 skill 时注册；MCP 工具仅在 `MCP_SERVERS`
> 非空且连接成功时注册。三者都不会改变「无配置」时的 builtin 路径。

## 4. 约束遵守

- **不加依赖**：只用 Node 内置 + 已有 core 代码。
- `pnpm typecheck` 全包 green（core / server / web）。
- `pnpm --filter @agent/web build` green（vite 产物已生成）。
- **未触碰** compaction / hooks / checkpoint / scheduler（INT-B）与权限模型。
- `.env` 从主 worktree 复制并本地追加 demo 配置；`.gitignore` 覆盖，未提交。
- MCP 连接失败路径：`try/catch` 内 `close()` + `console.warn` + 跳过，不致命。

## 5. 复现

```bash
cp D:/Project/agent-things/.env ./.env          # gitignored
pnpm install
pnpm typecheck
pnpm --filter @agent/web build
# 配置齐全（skills + MCP）：
$env:SKILLS_DIR='packages/core/src/mechanisms/skills/fixtures/skills'
$env:MCP_SERVERS='[{"name":"echo","command":"node","args":["packages/core/src/mechanisms/mcp/fixtures/echo-server.mjs"]}]'
pnpm --filter @agent/server start               # :8787 (demo 里用 PORT 覆盖)
# 什么都不配置：
$env:MCP_SERVERS='[]'; $env:SKILLS_DIR='data/no-skills'
pnpm --filter @agent/server start
node scripts/smoke.mjs "Read greet.mjs and ..."
```

代码位置：`packages/server/src/compose.ts`（组装根）、
`packages/core/src/events.ts`（`mechanism`）、`packages/core/src/agent/loop.ts`
（yield `result.events`）、`apps/web/src/components/TimelineTab.tsx` /
`Observatory.tsx`（渲染）。
