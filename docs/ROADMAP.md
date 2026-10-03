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

### M1 — 缓存与 token 经济

- **机制**：`cache_control` 断点、sticky routing（`session_id`）、usage 观测、
  **工具排序抖动导致 cache miss 的复现**（MECHANISMS §3 的真实 bug）。
- **实验**：同一会话连发两轮，观察 `cached_tokens`；再故意打乱工具顺序，观察归零。
- **交付**：观测台新增"缓存命中率 / 累计成本"视图 + 一篇实测文档。

### M2 — Skills 与渐进披露

- **机制**：三级披露（元数据常驻 / 正文按需 / 引用文件）。
- **实验**：正文注入的三种方式（改写 system vs 尾部 user 消息 vs tool result），
  对比 `cached_tokens` 曲线。
- **交付**：skill 加载器 + 实验数据 + 结论（回答"为什么不破坏缓存"）。

### M3 — 上下文压缩与回收

- **机制**：auto/manual compaction、tool-result clearing、固定位置摘要。
- **实验**：压缩后第一/二轮缓存恢复曲线；固定位置摘要 vs 拼进历史。
- **交付**：压缩器 + `/compact` 命令 + 实测文档（对齐 Claude Code 的 PreCompact 设计）。

### M4 — MCP 上下文管理

- **机制**：手写 MCP 客户端（stdio + http）、`tools`/`resources`/`prompts` 注入。
- **实验**：增删一个 server 对缓存与 token 的影响；工具搜索/代码执行式调用的压缩比。
- **交付**：MCP 客户端 + 对比文档（回答"MCP 的上下文管理机制是什么"）。

### M5 — 子 agent 与多 agent

- **机制**：独立上下文的 subagent、结果回灌、并行 fan-out。
- **实验**：子 agent 回灌 vs 主上下文直做的 token 账。
- **交付**：subagent 工具 + token 对比文档。

### M6 — 权限、hooks、checkpoint

- **机制**：交互审批、PreToolUse/PostToolUse/PreCompact hook、对话/代码独立回滚。
- **交付**：权限面板 + hook 系统 + rewind。

### M7 — background 与 scheduled tasks

- **机制**：非阻塞后台执行、定时任务、结果回灌策略。
- **交付**：后台任务面板 + 调度器。

### M8 — 会话 UX 与 CLI 副产物

- **机制**：session fork、diff 可视化、cost 面板；从同一内核导出 CLI。
- **交付**：fork/diff UI + `agent-things` CLI。

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
