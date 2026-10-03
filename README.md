# agent-things

一个**教学型最小 coding agent**：边实现、边观测、边讲清楚每个机制。

动机来自立党那条"本科生的三节课"（见 `original_request.md`）。本项目对应
第二节课（最小 coding agent）+ 第三节课（逐个实现 memory / skills / subagent /
compaction / MCP / session / 权限等机制）。重点不是"再造一个 agent"，而是**把
那些平时说不清楚的机制，用真实 API 的用量数据讲明白**。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/SPEC.md`](docs/SPEC.md) | 目标、非目标、已定决策、设计原则 |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 仓库结构、分层、核心接口、数据流 |
| [`docs/MECHANISMS.md`](docs/MECHANISMS.md) | 机制地图 + 已核实的真实事实 + 待验证问题 |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | 里程碑 M0–M8 与 Orca 并行开发策略 |
| [`docs/CONTRACT.md`](docs/CONTRACT.md) | 冻结的 HTTP / 事件契约 |

## 结构

```
packages/core    内核：类型、事件、OpenRouter 客户端、上下文装配、工具、循环、存储
packages/server  HTTP + SSE，把内核包成服务
apps/web         上下文观测台（Vite + React）
```

## 快速开始

```bash
pnpm install
cp .env.example .env   # 填入 OPENROUTER_API_KEY
pnpm dev               # server: :8787   web: :5173
```

打开 http://localhost:5173，在左侧对话，右侧"观测台"实时查看上下文、原始请求、
token 与缓存命中。

## 设计原则（摘要）

1. 一切皆上下文。2. 前缀稳定、只追加。3. 可观测优先。4. 传输与内核解耦。
5. 关键路径手写、不引 SDK。6. 接口先冻再并行。
