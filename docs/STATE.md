# STATE — coordinator handoff / resume notes

> 这份文件供**上下文压缩后**的协调者快速恢复。最后更新：2026-10-03。

## 1. 这个项目是什么

`agent-things`：一个**教学型最小 coding agent**，边实现边用真实 API 数据讲清机制。
起因见 `original_request.md`（立党的"本科生三节课"）。技术栈：TypeScript / Node，
pnpm monorepo（`packages/core` 内核 + `packages/server` HTTP/SSE + `apps/web` 观测台），
模型走 OpenRouter（**手写客户端**）。一切机制都自包含在 `packages/core/src/mechanisms/<name>/`。

## 2. 必读文档

| 文件 | 内容 |
|---|---|
| `docs/SPEC.md` | 目标/非目标/决策/原则 |
| `docs/ARCHITECTURE.md` | 分层、接口、数据流 |
| `docs/MECHANISMS.md` | 机制地图 + **§7 实测结论** |
| `docs/ROADMAP.md` | M0–M8 里程碑与状态 |
| `docs/CONTRACT.md` | 冻结的 HTTP/事件契约 |
| `docs/runs/*.md` | 每个里程碑的**实测数据** |
| `docs/mechanisms/*.md` | 每个机制的讲解 |
| `docs/briefs/*.md` | 派 worker 用的任务书 |

## 3. Git 状态

- 主 worktree：`D:/Project/agent-things`，分支唯一为 **`master`**。
- 所有历史 worker 分支已删除；当前只有 **`master`**，已并入 INT-A（`7fdeea1`）与 INT-B1（`c80bff3`）。
- 模型：`xiaomi/mimo-v2.6-flash`；`.env` 在仓库根，**gitignored**，含 `OPENROUTER_API_KEY`。
- TypeScript **7.0.2**（native），四份 manifest 均 `^7.0.2`；`pnpm typecheck` 全绿。
- 后台还跑着 `pnpm dev`（server :8787 / web :5173）——shell id `sh_101a314e2001DHKUbQx0gQmZDv`。

## 4. 已完成里程碑（均在 master）

| | 提交 | 关键实测 |
|---|---|---|
| M0 内核 + server + web | `5b86118`… | 真实"读→改→跑"验收（`docs/runs/m0-smoke.md`） |
| M1 缓存与 token 经济 | `1b4fb15` | 反转工具顺序 `cached 3328→0`；加 1 工具代价 ~34–40× |
| M2 skills 渐进披露 | `d4cd00b` | 尾部注入保留 3456；改写 system 前缀 → 640 |
| M4 MCP 上下文 | `eeb8434` | ~165 token/工具；加/重排工具 → cached 0 |
| M5 subagent | `dbabff7` | 父上下文 9420→858（−90.9%），总 token +15.5% |
| M3 压缩 | `9e30741` | 30917→4808（−84.4%）；压缩后必付一次 re-warm |
| M6 权限/hooks/checkpoint | `82ff99d` | 决策表全类别；checkpoint 字节级还原 12/12 |
| M7 后台/定时 | `96365f1` | 定时触发、后台非阻塞、结果回灌、cancel |

六个机制模块都在 `packages/core/src/mechanisms/`：`skills`、`mcp`、`subagent`、
`compaction`、`hooks`、`checkpoint`、`scheduler`。

## 5. ✅ 已完成：INT-A / INT-B1（整合阶段）

**INT-A（工具型机制）** — merge `7fdeea1`（worker `5a6f49c`），已复验：
- additive `mechanism` 事件 + 可选 `ToolResult.events`（`loop` 在 `tool.result` 后 yield）。
- `compose.ts`：builtin + `use_skill` + MCP stdio + `task`；`GET /api/mechanisms`；
  env `SKILLS_DIR` / `MCP_SERVERS` / `SUBAGENT_MAX_STEPS`。证据 `docs/runs/int-a.md`。

**INT-B1（hooks/permissions + compaction）** — merge `c80bff3`（worker `fa665f9`），已复验：
- `events.ts` `PermissionDecision` 增 `"ask"`；`AgentConfig` 增 optional
  `gate` / `hooks` / `compaction?`；`executeToolCall` 发真 verdict、用改写后的 input 执行、
  观察式 `postToolUse`；每步顶部按阈值自动压缩并发 `mechanism` 事件。
- server：env `HOOKS_FILE` / `POLICY_FILE` / `COMPACT_THRESHOLD_TOKENS` /
  `COMPACT_KEEP_RECENT` / `COMPACT_KEEP_LEADING` / `COMPACT_PLACEMENT`；
  新增 `POST /api/sessions/:id/compact`（未配置 409）。
- 复验（master，无配置）：`/compact` → 409，启动日志 hooks/policy/compaction 全 none。
  证据 `docs/runs/int-b1.md`（deny/ask/mutate 决策、压缩 21557→10921）。

> 两个整合都保证 **未配置 ⇒ 行为不变**。后台 `pnpm dev` 仍在跑；验证时用别的 `PORT`。

## 6. 待办

1. **INT-B2（进行中）**：checkpoint + scheduler 接入。
   `run_ee6e7ed91d2f` / task `task_d869257d8869` / dispatch `ctx_af61e3b6e2c7` /
   terminal `term_813cbb91-d7c2-4bef-af74-a40169c86eb9` / worktree `int-b2-checkpoint-scheduler` /
   brief `docs/briefs/int-b2-checkpoint-scheduler.md`。
   等待：`orca orchestration check --run run_ee6e7ed91d2f --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json`。
2. **M8**：session fork / diff 可视化 / cost 面板 / 从内核导出 CLI。
3. 清理：`m0-server/`、`m0-web/`、`m1-cache/`、`m2-skills/`、`m4-mcp/`、`m5-subagent/`
   是**无分支空壳目录**（被句柄锁着删不掉，已被 `.gitignore` 的 `/m[0-9]*-*/` 忽略），无害。

## 7. Orca 编排速查（本项目实际用法）

- 派发：`orca orchestration run-create --objective "..." --json`；然后
  `orca orchestration worker-start --spec "<自包含> --worktree new-top-level --agent opencode --name <n> --repo id:c9d5a4d1-e32e-45f8-b5f3-ac7e710bd3de --base-branch master --json`。
- 等待：`check --run <run> --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json`
  （**会打 `_keepalive` 心跳**，用 `Select-String -NotMatch '_keepalive'` 过滤）。
- 处理消息：heartbeat 要 **ack**，否则 FIFO 反复重放：
  `check --ack <deliveryId> --run <run> --wait --types ...`。
- 结算：`worker-release --dispatch <dispatch> --json`（**不接受 `--run`**）；
  然后 `check --ack <deliveryId> --run <run>`；再
  `worker-list --run <run> --terminal-state reclaimable --json`（应为 0）。
- 收回：`orca worktree rm --worktree "id:<repoId>::<path>" --force --json`
  （会一并删分支；分支名与目录同名时 `git log` 要用 `refs/heads/<name>` 或加 `--`）。
- 工作树建在仓库**内部**（`D:/Project/agent-things/<name>`），已被 gitignore。

## 8. 已知陷阱 / 约定

- **worker 打开的是 opencode，不向 Orca 上报存活状态**，所以 `worker-list` 常显示
  `unverifiable / missing_status`——这**不代表进程死了**。用 `Get-Process opencode`
  和 `terminal read` 确认真实状态；确认存活就继续等，不要 abandon。
- 并行 wave 的**唯一安全前提**：每个机制只写自己的目录 + 自己的脚本/文档，**零共享文件改动**。
  整合阶段（INT-x）才允许改共享文件，且**必须单 worker 串行**。
- worker 一律：不新增依赖（MCP/skill 手写）、`.env` 自己从主 worktree 拷（gitignored）、
  实验 API 调用有上限、完成必须发 `worker_done` 带 `--outcome` 与 `--report-path`。
- 合并前先 `pnpm typecheck`；合并后复跑该机制的实验/demo 确认可复现，再把数据回填
  `docs/runs/` 与 `docs/MECHANISMS.md §7`。

## 9. 用户偏好

- 语言：中文交流。
- 流程：**先文档、再并行**；每次并行前冻结接口。
- 用 **Orca 编排**（不是 opencode 自带 subagent）；希望有 `worker_done` 回调，
  不要靠轮询/猜。
- 模型测试用免费/便宜的 `xiaomi/mimo-v2.6-flash`。
- 验收是软要求，但机制文档要能被别人学会。
