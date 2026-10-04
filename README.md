# agent-things

一个**教学型最小 coding agent**：边实现、边观测、边讲清楚每个机制。

动机来自立党那条"本科生的三节课"（见 `original_request.md`）。本项目对应
第二节课（最小 coding agent）+ 第三节课（逐个实现 memory / skills / subagent /
compaction / MCP / session / 权限等机制）。重点不是"再造一个 agent"，而是**把
那些平时说不清楚的机制，用真实 API 的用量数据讲明白**。

> 状态：**M0–M8 全部完成**（含 INT-A/B1/B2 三个整合阶段）；**v2（M9 memory /
> M10 orchestrator / M11 tool-search）已由 INT-C 接进 server + web**；
> **M12 交互式审批 + 斜杠命令已完成**。`pnpm typecheck` 覆盖 core / server / web / cli，
> web 可构建。进度见 [`docs/ROADMAP.md`](docs/ROADMAP.md)，协调者交接见
> [`docs/STATE.md`](docs/STATE.md)，M12 证据见 [`docs/runs/m12.md`](docs/runs/m12.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | 目标、非目标、已定决策、设计原则 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 仓库结构、分层、核心接口、数据流 |
| [`docs/MECHANISMS.md`](docs/MECHANISMS.md) | 机制地图 + **已核实的真实事实**（§7） |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | 里程碑 M0–M8 与 Orca 并行开发策略 |
| [`docs/CONTRACT.md`](docs/CONTRACT.md) | 冻结的 HTTP / 事件契约 |
| [`docs/mechanisms/`](docs/mechanisms/) | 每个机制的讲解 |
| [`docs/runs/`](docs/runs/) | 每个里程碑的**实测数据** |
| [`docs/briefs/`](docs/briefs/) | 派给 worker 的任务书 |

## 结构

```
packages/core    内核：类型、事件、OpenRouter 客户端、上下文装配、工具、循环、存储
                 ＋ mechanisms/{skills,mcp,subagent,compaction,hooks,checkpoint,scheduler,
                   memory,orchestrator,tool-search,commands}
packages/server  HTTP + SSE，把内核包成服务（组装根 compose.ts、契约路由）
packages/cli     agent-things 命令行：同一个内核的第二个消费者
apps/web         上下文观测台（Vite + React；Timeline / Context / Usage / Diff …）
```

## 快速开始

```bash
pnpm install
cp .env.example .env          # 填入 OPENROUTER_API_KEY（默认模型 xiaomi/mimo-v2.6-flash）
pnpm dev                      # server: :8787   web: :5173
pnpm typecheck                # core + server + web + cli
```

打开 http://localhost:5173，左侧对话，右侧"观测台"实时查看上下文、原始请求、
token 与缓存命中、文件 diff、checkpoint、后台任务。

同一个内核也能从终端驱动：

```bash
pnpm --filter @agent/cli start "列一下当前目录"      # one-shot
pnpm --filter @agent/cli start                        # REPL
pnpm --filter @agent/cli exec tsx src/index.ts --help
```

## 已实现的机制

每个机制都自包含在 `packages/core/src/mechanisms/<name>/`，并在 server 里**按需开启、默认关闭**：

| 机制 | 开关（env） | 讲 / 证 |
|---|---|---|
| skills 渐进披露 | `SKILLS_DIR` | [skills.md](docs/mechanisms/skills.md) · [run](docs/runs/m2-skills.md) |
| MCP 工具 | `MCP_SERVERS`(JSON) | [mcp.md](docs/mechanisms/mcp.md) · [run](docs/runs/m4-mcp.md) |
| subagent 上下文隔离 | `SUBAGENT_MAX_STEPS` | [subagent.md](docs/mechanisms/subagent.md) · [run](docs/runs/m5-subagent.md) |
| compaction 压缩与回收 | `COMPACT_THRESHOLD_TOKENS` 等 | [compaction.md](docs/mechanisms/compaction.md) · [run](docs/runs/m3-compaction.md) |
| 权限 / hooks / checkpoint | `HOOKS_FILE` `POLICY_FILE` `CHECKPOINT_DIR` | [permissions.md](docs/mechanisms/permissions.md) · [run](docs/runs/m6-permissions.md) |
| background / scheduled | `SCHEDULER_ENABLED` | [scheduler.md](docs/mechanisms/scheduler.md) · [run](docs/runs/m7-scheduler.md) |
| memory 跨会话记忆 | `MEMORY_ENABLED` `MEMORY_DIR` `MEMORY_SYSTEM_INJECT` | [run](docs/runs/m9-memory.md) · INT-C |
| orchestrator 多 worker | `ORCHESTRATOR_ENABLED` `ORCHESTRATOR_MAX_WORKERS` | [mechanism](docs/mechanisms/orchestrator.md) · [run](docs/runs/m10-orchestrator.md) · INT-C |
| lazy tool exposure | `TOOL_SEARCH_ENABLED` | [run](docs/runs/m11-tool-search.md) · INT-C |
| interactive approval 交互审批 | `POLICY_FILE`/`HOOKS_FILE` + `APPROVAL_TIMEOUT_MS` | [approval.md](docs/mechanisms/approval.md) · [run](docs/runs/m12.md) |
| slash commands 斜杠命令 | 默认开启（`/help` `/memory` `/workers` `/compact`） | [commands.md](docs/mechanisms/commands.md) · [run](docs/runs/m12.md) |

## 设计原则（摘要）

1. 一切皆上下文。2. 前缀稳定、只追加。3. 可观测优先。4. 传输与内核解耦。
5. 关键路径手写、不引 SDK。6. 接口先冻再并行。
