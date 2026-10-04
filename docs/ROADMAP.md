# 路线图 (ROADMAP)

里程碑按"机制"而非"功能"切分。每个 Mx 的完成定义是：**可运行实现 + 事件流观测 +
一篇带实测数据的机制文档**。

## 依赖与并行

- **M0 是一切的地基**，必须先冻结接口（`AgentEvent` + HTTP 契约）。
- M1–M5 大多只依赖 M0 的冻结接口，且各自住在 `packages/core/src/mechanisms/<name>/`
  下，**可以并行**。
- 并行冲突的唯一来源是 `events.ts` / `index.ts` 的追加。规则：**只做追加式扩展**
  （新增事件类型、新增导出），不改名、不改已有字段语义。这样合并基本是机械的。

## 里程碑

### M0 — 纵向切片：能观测的最小循环 ✅（进行中）

- **机制**：L0 循环、L1 上下文装配、L2 手写客户端与 usage、L6 事件日志、L8 观测台。
- **交付**：`@agent/core` + `@agent/server` + `apps/web`，能输入任务、跑工具循环、
  在 web 面板看到 messages / token / cache。
- **验收**：`pnpm dev` 后能对一个真实仓库完成一次"读→改→跑"。

### M1 — 缓存与 token 经济 ✅

- **机制**：`cache_control` 断点、sticky routing（`session_id`）、usage 观测、
  **工具排序抖动导致 cache miss 的复现**（MECHANISMS §3 的真实 bug）。
- **实验**：同一会话连发两轮，观察 `cached_tokens`；再故意打乱工具顺序，观察归零。
- **交付**：实测数据见 [`docs/runs/m1-cache.md`](runs/m1-cache.md)，观测台新增 running
  命中率/累计花费。
- **实测（`xiaomi/mimo-v2.6-flash`）**：相同请求第 2 次起 `cached=3328/3371`（98.7%）；
  **反转 tools 顺序 → cached 0**；追加 1 个工具（+83 token）→ cached 0–512（代价是新增
  字节的 ~34–40 倍）；system 改 1 byte → 丢 84.6%；append-only 恒定 3328。

### M2 — Skills 与渐进披露 ✅

- **机制**：三级披露（元数据常驻 / 正文按需 / 引用文件）。
- **实验**：正文注入的三种方式（改写 system vs 尾部 user 消息 vs tool result），
  对比 `cached_tokens` 曲线。
- **交付**：[`docs/mechanisms/skills.md`](mechanisms/skills.md)、
  [`docs/runs/m2-skills.md`](runs/m2-skills.md)。
- **实测**：尾部 user 消息 / tool result 注入，`cached` 保持 3456（follow 达 99.5%）；
  **改写 system 前缀 → `cached` 塌到 640**。修正 MECHANISMS §2：只有"非追加地改动
  已缓存前缀"才失效，追加到 system 尾部等价于尾部消息。

### M3 — 上下文压缩与回收 ✅

- **机制**：compaction（摘要化中段）、tool-result clearing、摘要位置对比。
- **交付**：`mechanisms/compaction/`（纯消息数组变换 + transcript 校验器）、
  [`docs/mechanisms/compaction.md`](mechanisms/compaction.md)、
  [`docs/runs/m3-compaction.md`](runs/m3-compaction.md)。
- **实测（25 calls）**：压缩 `30917 → 4808`（−84.4%）；**压缩后第 1 次 `cached=0`（必然
  一次全量 re-warm），第 2 次回到 98.5%**。摘要**拼进历史**保留共享头 4608，**固定首槽**
  仅保留 512（Δ=4096）→ 拼进历史明显更省缓存。`clearToolResults` 回收 50.1%
  （vs compact 84.4%），恢复后命中 99.4%。

### M4 — MCP 上下文管理 ✅

- **机制**：手写 MCP 客户端（stdio JSON-RPC，无 SDK）、`tools/list`/`tools/call`。
- **交付**：[`docs/mechanisms/mcp.md`](mechanisms/mcp.md)、
  [`docs/runs/m4-mcp.md`](runs/m4-mcp.md)。（`resources`/`prompts` 注入时机、
  工具搜索/代码执行式调用列为后续。）
- **实测**：N 个 MCP 工具约 **165 token/个**（N=20 在 2842 基线上 +3300）；加 1 个
  工具 `cached` 3328→0，重排同一集合 3456→0，**放大 ~16–20×**。

### M5 — 子 agent 与多 agent ✅

- **机制**：独立上下文的 subagent、结果回灌。
- **交付**：[`docs/mechanisms/subagent.md`](mechanisms/subagent.md)、
  [`docs/runs/m5-subagent.md`](runs/m5-subagent.md)。
- **实测**：委派把父上下文最终 `prompt_tokens` **9420 → 858（−90.9%）**；总 token
  +15.5%（10544→12178）、成本 $0.00119→$0.00141。隔离缩小主上下文，代价是总 token 略增。

### M6 — 权限、hooks、checkpoint ✅

- **机制**：HookRunner（preToolUse/postToolUse/preCompact/userPromptSubmit，匹配后返回
  allow/deny/ask/mutate）、有序规则策略 + 统一 `decide()`、按 turn 的字节级 CheckpointStore。
- **交付**：`mechanisms/hooks/`、`mechanisms/checkpoint/`、
  [`docs/mechanisms/permissions.md`](mechanisms/permissions.md)、
  [`docs/runs/m6-permissions.md`](runs/m6-permissions.md)。
- **实测（零 API）**：决策表覆盖 allow/ask/deny/mutate/hook-deny；还原文本、二进制 0..255、
  "快照时不存在、之后被创建"的文件均 sha256 一致，12/12 断言通过。代码回滚与对话回滚解耦。

### M7 — background 与 scheduled tasks ✅

- **机制**：Scheduler（one-shot/interval、非阻塞、状态捕获、cancel、drain）、
  `runInBackground`、结果回灌为消息（并记录 event 映射，不改 `events.ts`）。
- **交付**：`mechanisms/scheduler/`、[`docs/mechanisms/scheduler.md`](mechanisms/scheduler.md)、
  [`docs/runs/m7-scheduler.md`](runs/m7-scheduler.md)。
- **实测（零 API）**：定时任务 1018ms 触发；后台任务 +1ms 返回、+721ms settle；
  cancel runs=0；interval 触发两次；结果回灌成消息。全部断言通过。

### M8 — 会话 UX 与 CLI 副产物 ✅

- **机制**：session fork、diff 可视化、cost 面板；从同一内核导出 CLI。
- **交付**：fork/diff UI + `agent-things` CLI；[`docs/runs/m8.md`](runs/m8.md)。
- **实测**：fork@1 精确复制源前缀（1/6 条，事件日志空）；真实写 turn 产出
  `mechanism` diff `+1/−0`；CLI 以 `xiaomi/mimo-v2.6-flash` 跑通真实 turn 并打印
  usage/cost；typecheck 4 包 + web build 全绿。

## 并行开发（Orca worktrees）

M0 完成并提交后，每个里程碑开一个独立 Orca worktree + agent 终端，从主干分支：

```
orca worktree create --name m2-skills --no-parent --agent <agent> \
  --prompt "<该里程碑的 brief：读 docs/MECHANISMS.md §2 §6，实现并做实验>" --json
```

规则：

1. 每个 worktree 只动自己 `mechanisms/<name>/` 下的文件 + 追加式改 `events.ts`/`index.ts`。
2. 机制文档写在各自 worktree 的 `docs/mechanisms/<name>.md`，避免同文件冲突。
3. 合入顺序：先小后大；每次合入后跑 `pnpm typecheck`。
4. 接口变更必须先改 `docs/CONTRACT.md` 并在主 worktree 落定，再同步给各 worker。

## 当前进度

- [x] 需求盘问（SPEC §4 决策表）
- [x] 冻结契约 `docs/CONTRACT.md`
- [x] 机制地图 `docs/MECHANISMS.md`
- [x] core 内核（M0）
- [x] server + web（M0，Orca 并行完成并合入 master）
- [x] 一次真实"读→改→跑"验收（见 `docs/runs/m0-smoke.md`）
- [x] M1 缓存与 token 经济（见 `docs/runs/m1-cache.md`）
- [x] M2 skills 渐进披露（见 `docs/runs/m2-skills.md`）
- [x] M4 MCP 上下文（见 `docs/runs/m4-mcp.md`）
- [x] M5 subagent 上下文隔离（见 `docs/runs/m5-subagent.md`）
- [x] M3 压缩与回收（见 `docs/runs/m3-compaction.md`）
- [x] M6 权限/hooks/checkpoint（见 `docs/runs/m6-permissions.md`）
- [x] M7 后台/定时任务（见 `docs/runs/m7-scheduler.md`）
- [x] INT-A 工具型机制接入 server（skills/MCP/subagent；见 `docs/runs/int-a.md`）
- [x] INT-B1 循环型机制（hooks/permissions + compaction；见 `docs/runs/int-b1.md`）
- [x] INT-B2 循环型机制（checkpoint + scheduler；见 `docs/runs/int-b2.md`）
- [x] M8 会话 UX 与 CLI 副产物（见 `docs/runs/m8.md`）
- [x] INT-C memory + orchestrator + tool-search 接入 server/web（见 `docs/runs/int-c.md`）

## v2 规划（M9–M12）

v1（M0–M8）把 post 清单里的机制基本补齐；v2 补三块**第三节课的空白**，并把
subagent/scheduler 升格成一个真正的 **orchestrator**。

| 里程碑 | 机制 | 一句话 | 状态 |
|---|---|---|---|
| M9 | memory | 跨会话记忆 + 召回；**注入位置对缓存的影响** | INT-C ✅ |
| M10 | orchestrator | supervisor + 持久 mailbox（wait/ack）+ worker 注册表；**事件流原生、不需要 PTY** | INT-C ✅ |
| M11 | lazy tool exposure | 用一个 `tool_search`/`tool_call` 门面替换 N 份工具 schema，压缩前缀 | INT-C ✅ |
| M12 | interactive approval + slash commands | 把 `ask` verdict 变成真正的人机审批；slash 命令注入点 | 待定 |

wave-3 并行（`docs/briefs/_wave3-constraints.md`）：三个机制各自只在
`packages/core/src/mechanisms/<name>/` + 自己的脚本/文档内改动，**零共享文件改动**；
server/web/契约的接线由 INT-C 单 worker 波次完成（env
`MEMORY_ENABLED`/`MEMORY_DIR`/`MEMORY_SYSTEM_INJECT`、
`ORCHESTRATOR_ENABLED`/`ORCHESTRATOR_MAX_WORKERS`、`TOOL_SEARCH_ENABLED`；
路由 `GET /api/memories`、`GET /api/workers`；证据 `docs/runs/int-c.md`）。

关于 orchestrator 的取舍：worker 是**本内核的 `Agent`**，编排走结构化事件流，
所以**不引入终端模拟器**；PTY 只在需要托管**外部黑盒 TTY agent**（claude-code /
codex / opencode）时，作为一个独立 transport adapter 再引入。
