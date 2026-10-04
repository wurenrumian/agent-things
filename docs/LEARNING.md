# LEARNING — 三节课学习路径

这份文档把仓库映射到 [`original_request.md`](../original_request.md) 里立党那条 post 的
**三节课**：先买 plan 用现成工具，再自己写最小 coding agent，最后逐个机制观察并实现。
目标是 SPEC §3 的三条软标准：**可测量 / 可复现 / 可讲清**
（见 [`docs/SPEC.md`](SPEC.md) §3）。

阅读顺序建议：先看第二课把最小循环跑通，再按第三课的**依赖从简到难**顺序往下看。每一章
统一用五段结构：

> **一句话心智模型 → 实现文件 → 实验脚本 → 实测数字 → 一个"钩子问题"**

所有实测数字都能在链到的 `docs/runs/*.md` 里逐字找到；本页不发明任何数字。

---

## 第一课：买 plan，用 claude-code / codex

这一课**不在本仓库的代码范围内**——它的产出是"用过真家伙"的直觉。post 的原话是
"买一个最大的 coding plan，用上 claude code 或者 codex"（见
[`original_request.md`](../original_request.md)）。

项目为什么要先补这一课：只有先用过成熟的 coding agent，才会对 memory、skills、
subagent、background tasks、session 管理、context compression 这些机制**有体感**，
后面自己做时才知道"缺了什么、为什么难"。本项目对应的是**第二节课 + 第三节课**，
第一课请自行完成，不在仓库里复现。

---

## 第二课：自己写一个最最最小的 coding agent

**一句话心智模型**：一个 turn 就是一个状态机——
`push(user) → compile(system + history + tools) → request → 有 tool_calls?`
→ 有则逐个裁决/执行、把结果 `push(tool)` 后回到 compile；无则 `stop`。
关键不变式：**`messages` 只追加，从不原地修改**。

- **实现文件**：[`packages/core/src/agent/loop.ts`](../packages/core/src/agent/loop.ts)
  （`Agent.run()` async generator，L0 循环）；上下文装配
  [`packages/core/src/content.ts`](../packages/core/src/content.ts)；
  手写模型客户端
  [`packages/core/src/provider/openrouter.ts`](../packages/core/src/provider/openrouter.ts)。
- **规格与架构**：[`docs/SPEC.md`](SPEC.md) §1/§6、
  [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)（仓库布局、事件词表、Agent 循环、数据流）。
- **第一次真实验收**：[`docs/runs/m0-smoke.md`](runs/m0-smoke.md)。
  任务：读 `greet.mjs` → 加 `farewell(name)` → 跑 `node` → 报告输出。一轮到底通过：
  4 个 step 的 `prompt` 为 980 / 1066 / 1223 / 1253，第 3 步 `run_shell` 的 `cached`
  跳到 **1201**（占 prompt 98%）——这是缓存现象的第一颗种子，直接催生了 M1。
  该 run 还记录了一个只有接真模型才会暴露的 bug：`contentToText` 未处理 `null`，
  修复它在 `content.ts`。

**外壳（可选但推荐）**：最小内核被三种消费者复用——server/web/CLI。想在终端里直接
驱动同一内核，看 [`docs/runs/m8.md`](runs/m8.md)：`agent-things` CLI
（`packages/cli/`）跑真实 turn 打印 usage/cost；同一 run 还给出 session fork
（fork@1 复制 1/6 条、事件日志为空）、文件 diff 事件（`+1/−0`）与 cost 面板的证据。

> **钩子问题**：为什么"只追加、不原地改"这条不变式，会在第三课几乎所有机制里反复出现？

---

## 第三课：逐个机制

下面按**依赖从简到难**排。每一章都指向机制实现、实验脚本与实测记录。

### 3.1 缓存与 token 经济（M1）

- **心智模型**：每一步请求都是"**稳定前缀 + 易变尾部**"。provider 的前缀缓存只承认逐字节
  稳定的前缀；任何**非追加式**改动都会让改动点之后全部重建。所有机制都在"前缀稳定"与
  "上下文别太大"之间做权衡。
- **实现文件**：[`packages/core/src/provider/openrouter.ts`](../packages/core/src/provider/openrouter.ts)
  （手写流式客户端 + `usage`）、[`packages/core/src/content.ts`](../packages/core/src/content.ts)
  （`withCacheBreakpoint()` 缓存断点标记）；稳定排序在
  [`packages/core/src/tools/registry.ts`](../packages/core/src/tools/registry.ts)。
- **实验脚本**：[`packages/server/scripts/cache-experiment.ts`](../packages/server/scripts/cache-experiment.ts)。
- **实测数字**：相同请求第 2 次起 `cached=3328/3371`（98.7%）；**反转 tools 顺序**
  3328 → **0**（3/3 复现）；追加 1 个工具（prompt +83）→ **0–512**（代价是新增字节的
  ~34–40 倍）；system 改 1 byte → 512（丢 **84.6%**）；append-only 恒定 3328。
  成本：冷调用 `$0.000375`、命中 `$0.000309`（约 **−18%**）。
  → [`docs/runs/m1-cache.md`](runs/m1-cache.md)
- **钩子问题**：如果你必须在中途改 sandbox 配置或 cwd，你会**改旧消息**还是**追加一条
  新消息**？为什么？（提示：M1 §1.4 的"切回"行为。）

### 3.2 Skills 与渐进披露（M2）

- **心智模型**：skill 分三级——**元数据常驻**（name + description）、**正文按需**
  （`SKILL.md`）、**引用文件再按需**；正文永远落在尾部，前缀不动。
- **实现文件**：[`packages/core/src/mechanisms/skills/`](../packages/core/src/mechanisms/skills/)
  （`registry.ts` / `use-skill.ts` / `frontmatter.ts`）。
- **实验脚本**：[`packages/server/scripts/skills-experiment.ts`](../packages/server/scripts/skills-experiment.ts)。
- **实测数字**：尾部 `user` 消息注入 `cached` 保持 **3456**；`tool` result 注入同样
  **3456**，`follow-tool` 达 **99.5%**；改写 system 前缀 → `cached` **0**（follow 回
  640）；把同一段正文**追加到 system 末尾**则仍 **3456**。
  → [`docs/runs/m2-skills.md`](runs/m2-skills.md)
- **钩子问题**：为什么同一份正文接到 **system 末尾**不掉缓存，插到**中间**就全灭？
  （提示：前缀缓存是"纯位置"的。）

### 3.3 MCP 的上下文管理（M4）

- **心智模型**：MCP 是 **eager** 的——每个已连接 server 的工具元数据**每轮全量注入**，
  与是否调用无关；工具集就是前缀的一部分，成员或顺序一变整段失效。
- **实现文件**：[`packages/core/src/mechanisms/mcp/`](../packages/core/src/mechanisms/mcp/)
  （`transport.ts` stdio JSON-RPC、`client.ts` `initialize`/`tools/list`/`tools/call`）。
- **实验脚本**：[`packages/server/scripts/mcp-experiment.ts`](../packages/server/scripts/mcp-experiment.ts)。
- **实测数字**：每个 MCP 工具 ≈ **165 token**（N=20 在 2842 基线上 **+3300**，prompt
  +116%）；往热集合**追加 1 个**工具，prompt 只 +169，却把 `cached` 从 3328 打到
  **0/640**，放大 **~16–20 倍**；**只重排顺序** 3456 → **0**。
  → [`docs/runs/m4-mcp.md`](runs/m4-mcp.md)
- **钩子问题**：接第 6 个 MCP server 时，你的"**增量**"到底是什么？代价落在那一个工具上，
  还是一整段已缓存前缀上？

### 3.4 Compaction 压缩与上下文回收（M3）

- **心智模型**：压缩 = **缩短 + 改写历史前缀**，与前缀缓存天然冲突；"摘要放在哪"决定
  能保住多少共享头。
- **实现文件**：[`packages/core/src/mechanisms/compaction/`](../packages/core/src/mechanisms/compaction/)
  （`compact.ts` 摘要化中段、`clear-tool-results.ts` 只丢正文保结构、`validate.ts` 校验）。
- **实验脚本**：[`packages/server/scripts/compaction-experiment.ts`](../packages/server/scripts/compaction-experiment.ts)。
- **实测数字**：prompt **30923 → 4814（−84.4%）**；压缩后**第 1 次 `cached=0`**
  （必然一次全量 re-warm），**第 2 次 4736/4814（98.4%）**；摘要**拼进历史**保住共享头
  4608，**固定前导槽位**只剩 512（**Δ=4096**）；`clearToolResults` 回收 **50.1%**、
  恢复后命中 **99.5%**。
  → [`docs/runs/m3-compaction.md`](runs/m3-compaction.md)
- **钩子问题**：为什么"压缩复用主会话缓存"这个 feature flag，在**截断**场景下救不了压缩
  那一次调用？（提示：缓存长的不能命中更短的请求。）

### 3.5 Subagent 上下文隔离（M5）

- **心智模型**：子 agent = **独立 message 数组 + 独立 system prompt + 去掉 `task` 的工具集**；
  只有**最终 assistant 文本**作为一条 `tool` result 回灌父上下文，中间 tool 输出从不进入。
- **实现文件**：[`packages/core/src/mechanisms/subagent/index.ts`](../packages/core/src/mechanisms/subagent/index.ts)
  （`runSubagent` / `createTaskTool` / `subagentTools`）。
- **实验脚本**：[`packages/server/scripts/subagent-experiment.ts`](../packages/server/scripts/subagent-experiment.ts)。
- **实测数字**：父上下文最终 `prompt_tokens` **9420 → 858（−90.9%）**；全链路总 token
  10544 → 12178（**+15.5%**）、成本 $0.001190 → $0.001414（**+18.8%**）。
  → [`docs/runs/m5-subagent.md`](runs/m5-subagent.md)
- **钩子问题**：什么情况下 delegation 是**净亏**？试着用"省下的主上下文 × 它还要在后续多少
  个 turn 里继续被付费"来算。

### 3.6 Hooks / 权限 / Checkpoint（M6）

- **心智模型**：所有工具调用在执行前的**同一道缝**上合成一个 `decide()`——有序规则先命中，
  生命周期 hooks 可覆盖或否决，裁决为 allow / ask / deny / mutate；checkpoint 只认**字节与
  turn id**，与会话历史解耦。
- **实现文件**：[`packages/core/src/mechanisms/hooks/`](../packages/core/src/mechanisms/hooks/)
  （`policy.ts` / `runner.ts` / `decide.ts`）、
  [`packages/core/src/mechanisms/checkpoint/`](../packages/core/src/mechanisms/checkpoint/)
  （`store.ts`）。
- **实验脚本**：[`packages/server/scripts/hooks-experiment.ts`](../packages/server/scripts/hooks-experiment.ts)。
- **实测数字（0 API）**：决策表覆盖 **allow / ask / deny / mutate / hook-deny** 五种结果；
  `preCompact` 注入"保留什么"指令；checkpoint 对文本、二进制 `0..255`、"快照时不存在"的
  文件做字节级还原，**12/12 断言 PASS**（sha256 判定）。**本里程碑无缓存数字。**
  → [`docs/runs/m6-permissions.md`](runs/m6-permissions.md)
- **钩子问题**：为什么把裁决集中在"执行前的一层"，比散在每个工具内部各自判断更好？

### 3.7 Scheduler 后台与定时任务（M7）

- **心智模型**：调度**不改循环、不改事件流**；任务结果只在被**显式注入**时成为一条**尾部
  `user` 消息**（append-only），所以不破坏缓存前缀。
- **实现文件**：[`packages/core/src/mechanisms/scheduler/`](../packages/core/src/mechanisms/scheduler/)
  （`scheduler.ts` / `background.ts` / `reinject.ts`）。
- **实验脚本**：[`packages/server/scripts/scheduler-experiment.ts`](../packages/server/scripts/scheduler-experiment.ts)。
- **实测数字（0 API）**：一次性任务实测 **1018ms** 触发；`runInBackground` **+1ms** 返回、
  任务 **+721ms** settle；cancel 后 `runs=0`；interval 480ms 内触发 **2** 次；`drain()`
  返回 **5** 条；**2** 条结果回灌为消息。**本里程碑无缓存数字。**
  → [`docs/runs/m7-scheduler.md`](runs/m7-scheduler.md)
- **钩子问题**：后台结果发生在 turn **之外**，为什么它不能作为 `role:"tool"` 回灌，而必须
  作为一条**新的 user 消息**？

### 3.8 Memory 跨会话记忆（M9）

- **心智模型**：记忆是**持久状态**（append-only NDJSON 日志），检索结果是**尾部 `tool`
  result**，绝不作为常驻 system 前缀。
- **实现文件**：[`packages/core/src/mechanisms/memory/`](../packages/core/src/mechanisms/memory/)
  （`store.ts` / `recall.ts` / `render.ts` / `tool.ts`）。
- **实验脚本**：[`packages/server/scripts/memory-experiment.ts`](../packages/server/scripts/memory-experiment.ts)。
- **实测数字**：会话 A 存 3 条后，**全新**会话 B 只共享磁盘目录，调用 `memory search`
  答出 **"Blue Lantern"**；缓存注入——prefix rewrite 3648 → **0**，tail injection
  3584 → **3584**（逐字节不变）；`selftest` **7/7 passed**。
  → [`docs/runs/m9-memory.md`](runs/m9-memory.md)
- **钩子问题**：为什么"记忆内容变化"本身不该被当成缓存事件，真正决定成本的是**注入位置**？

### 3.9 Orchestrator 编排（M10）

- **心智模型**：worker 就是**进程内的 `Agent`**（自有 session 与消息数组）；协调走
  **结构化 mailbox + registry + `AgentEvent` 流**，**不需要 PTY**。
- **实现文件**：[`packages/core/src/mechanisms/orchestrator/`](../packages/core/src/mechanisms/orchestrator/)
  （`supervisor.ts` / `mailbox.ts` / `registry.ts` / `tools.ts`）。
- **实验脚本**：[`packages/server/scripts/orchestrator-experiment.ts`](../packages/server/scripts/orchestrator-experiment.ts)。
- **实测数字**：Run B（读大文件微任务）coordinator 主上下文 **8793 → 1926（−78.1%）**，
  全链路 total 9829 → 21970（**+123%**）、成本 **+120%**；Run A 小任务反例 coordinator
  **1386 → 1907（+37.6%）**；5 个 session id **互不相同**、无跨上下文泄漏；未 ack 投递
  重放 **7/7 PASS**（0 API）。
  → [`docs/runs/m10-orchestrator.md`](runs/m10-orchestrator.md)
- **钩子问题**：`wait` + `ack` 为什么比轮询好？一条**未 ack** 的消息为什么会被下一次
  `wait()`/投递**重放**？（提示：at-least-once。）

### 3.10 Tool-search 惰性工具暴露（M11）

- **心智模型**：用一个 `tool_search` + `tool_call` 的**门面**替换 N 份工具 schema；常驻
  前缀只由 system + **两个固定 schema** 组成，与实际拥有多少真实工具无关，对工具集变化免疫。
- **实现文件**：[`packages/core/src/mechanisms/tool-search/`](../packages/core/src/mechanisms/tool-search/)
  （`tool-index.ts` 确定性索引、`facade.ts` 两个 facade 工具）。
- **实验脚本**：[`packages/server/scripts/tool-search-experiment.ts`](../packages/server/scripts/tool-search-experiment.ts)。
- **实测数字**：N=25 下常驻前缀 **4777 → 3100（−1677，−35.1%）**，边际 ≈ **73 token/工具**
  （按 M4 的 ~165 token/工具外推，真实 MCP 工具的节省更大）；同一任务 total token
  **4625 → 2714（−41.3%）**，成本 eager $0.000310 vs lazy $0.000339（多一次搜索往返）；
  索引确定性 **PASS**（原序 vs 反转序逐字节相同）。
  → [`docs/runs/m11-tool-search.md`](runs/m11-tool-search.md)
- **钩子问题**：lazy 一定更便宜吗？多出的那**一次搜索往返**，要在什么规模下才会被前缀节省
  盖过？

### 3.11 交互式审批与斜杠命令（M12）

- **心智模型**：`ask` 不是乐观放行，而是**被 await 的真实人机决策**；斜杠命令是**输入
  预处理**（命中命令即**零模型 turn**），且只**追加**消息、不重写缓存前缀。
- **实现文件**：[`packages/core/src/agent/loop.ts`](../packages/core/src/agent/loop.ts)
  （`AgentConfig.approvals` + `executeToolCall`）、
  [`packages/core/src/mechanisms/commands/`](../packages/core/src/mechanisms/commands/)
  （`registry.ts` / `builtins.ts`）；讲解见
  [`docs/mechanisms/approval.md`](mechanisms/approval.md)、
  [`docs/mechanisms/commands.md`](mechanisms/commands.md)。
- **实验脚本**：[`packages/server/scripts/approval-experiment.ts`](../packages/server/scripts/approval-experiment.ts)。
- **实测数字**：deny 腿事件序列 `tool.call → permission.decision → approval.requested →
  approval.resolved`（无 `tool.result`，文件不生成）；回调里 `sleep(250ms)` ⇒ 两次
  `Δ≈263ms / 264ms`，**证明循环停在 promise 上**；allow 腿文件字节 `M12-ALLOW-m12a`
  （14B，sha256 `f493a861…`）；服务器超时 **~1513ms** 后 resolve `deny`（fail closed）；
  `/help` 帧只有 `mechanism(command) + assistant.message + turn.end`（**零模型 turn**）；
  命令注册表自测 **12/12 PASS**。
  → [`docs/runs/m12.md`](runs/m12.md)
- **钩子问题**：为什么审批**超时**的默认裁决必须是 `deny`（fail closed），而不是放行？

---

## 怎么自己复现

### 模型与 `.env`

- 实验模型固定为 **`xiaomi/mimo-v2.6-flash`**（OpenRouter，自动前缀缓存）。
  例外：M0 smoke 用的是免费模型 `stealth/space-bunny-alpha`，它在 append-only 上会抖动
  （见 [`docs/runs/m1-cache.md`](runs/m1-cache.md) §4），因此后续里程碑统一换成
  `mimo-v2.6-flash`。
- 需要 API 的实验：从主 worktree 复制 gitignored 的 `.env`（**不要提交**）：
  `cp D:/Project/agent-things/.env ./.env`（PowerShell 用 `copy`）。脚本自己加载仓库根的
  `.env`。
- **M6 / M7 不需要 `.env`**：它们**零模型、零网络**，只用 `@agent/core` 的纯函数与
  `node:timers`。
- 环境约束：温度 0、固定 `session_id`（启用 OpenRouter sticky routing，前缀缓存要求同
  provider 实例命中）、相邻调用间隔 500ms、调用量有预算并做 429 退避。

### 安装与运行

```bash
# 1) 安装（每个 worktree 各一次）
pnpm install

# 2) 各机制的实验脚本（都在 packages/server/scripts/ 下）
pnpm --filter @agent/server exec tsx scripts/cache-experiment.ts --salt=mimo001
pnpm --filter @agent/server exec tsx scripts/skills-experiment.ts --salt=mimo-m2-001
pnpm --filter @agent/server exec tsx scripts/mcp-experiment.ts --salt=m4mcp001
pnpm --filter @agent/server exec tsx scripts/compaction-experiment.ts spliced leading clear --salt=mimo-m3-001
pnpm --filter @agent/server exec tsx scripts/subagent-experiment.ts
pnpm --filter @agent/server exec tsx scripts/hooks-experiment.ts            # 无需 .env
pnpm --filter @agent/server exec tsx scripts/scheduler-experiment.ts       # 无需 .env
pnpm --filter @agent/server exec tsx scripts/memory-experiment.ts --salt=mimo-m9-001
pnpm --filter @agent/server exec tsx scripts/orchestrator-experiment.ts
pnpm --filter @agent/server exec tsx scripts/tool-search-experiment.ts --salt=m11mimo001
pnpm --filter @agent/server exec tsx scripts/approval-experiment.ts --salt=m12a
```

- 多数脚本支持**零 API 自检**或分腿运行，想省钱先跑这些：
  `compaction-experiment.ts selftest`、`mcp-experiment.ts --roundtrip-only`、
  `tool-search-experiment.ts --index-only`、`memory-experiment.ts selftest`、
  `orchestrator-experiment.ts replay`、`approval-experiment.ts` 的 Part 0。
- `--salt=...` 会写进每个 system prompt，保证一次运行用的是**从未缓存过的新前缀**，
  让"命中/未命中"可判读；省略时脚本用随机 salt。
- 约束：**不要起长驻 HTTP server**，用上面这种脚本模式。最后可跑 `pnpm typecheck`
  （全包 green）。

### 数字可能随模型 / 日期漂移

缓存命中受 **provider 侧**因素影响：sticky routing、缓存分块粒度、TTL 抖动。run 文档里
如实记过这些现象——例如 M1 §1.2/§1.4 的 `512`、`0` 中间态，M9 §3.2 的 `64`-token 粒度差
（`warm#2` 3648 vs 3584），M11 §2.3 里同样的 `0/512` 抖动。**方向性结论**（"非追加式改写
前缀则失效""尾部追加则保持命中"）是稳定的；**精确绝对值**会随模型/日期/provider 漂移。
M6/M7 不含 API 调用，不受此影响。

---

## 读代码入口

按这条主线读，再进机制，最省力：

1. [`packages/core/src/agent/loop.ts`](../packages/core/src/agent/loop.ts) — L0 turn 状态机
   （`push(user) → compile → request → tool_calls? → execute → push(tool) → compile`）。
2. [`packages/core/src/content.ts`](../packages/core/src/content.ts) — `compileMessages()`
   组装 `[system, ...history]`、`withCacheBreakpoint()` 缓存断点、粗估 token。
3. [`packages/core/src/provider/openrouter.ts`](../packages/core/src/provider/openrouter.ts) —
   手写 `fetch` + SSE 解析、原始请求体、`session_id` sticky routing、`usage`
   （`cached_tokens` / `cache_write_tokens`）。
4. [`packages/core/src/tools/`](../packages/core/src/tools/) —
   `registry.ts`（按名稳定排序）/ `builtin.ts`（内置工具）。
5. [`packages/core/src/context/system-prompt.ts`](../packages/core/src/context/system-prompt.ts) —
   L1 系统提示分段与 `AGENTS.md` 发现。
6. 再进 [`packages/core/src/mechanisms/`](../packages/core/src/mechanisms/) 逐个机制：
   `skills/`、`mcp/`、`compaction/`、`subagent/`、`hooks/`、`checkpoint/`、`scheduler/`、
   `memory/`、`orchestrator/`、`tool-search/`、`commands/`；每个目录旁通常配一篇
   [`docs/mechanisms/`](mechanisms/) 讲解。

**观测与回放**：事件词表在 [`packages/core/src/events.ts`](../packages/core/src/events.ts)，
session 与事件日志在 [`packages/core/src/store/session.ts`](../packages/core/src/store/session.ts)，
观测台在 [`apps/web/`](../apps/web/)（Diff tab、Usage/Cost、Timeline）。

**权威索引**：[`docs/MECHANISMS.md`](MECHANISMS.md)（§0 心智模型、§6 待验证问题、
§7 实测结论回填）、[`docs/ROADMAP.md`](ROADMAP.md)（每个里程碑的完成定义）、
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md)（分层与接口）。
