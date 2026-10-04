# 机制地图 (MECHANISMS)

这份文档是"第三节课"的研究计划。每一层机制都写成同一结构：
**它是什么 → 要回答的钩子问题 → 已核实的真实事实 → 我们的实验/实现**。

> 原则：凡引用真实实现的地方都标来源；凡是我的推断都写"待验证"。
> 本项目最终要能用自己的 `usage` 数据验证这些说法。

## 0. 底层心智模型

一句话：**agent 的全部能力，本质都是"在正确的时机，把正确的字符放进消息数组"。**
工具、记忆、skill、MCP、子 agent，区别只在于——

1. **何时放**（常驻 / 按需 / 惰性）
2. **放多少**（全量 / 摘要 / 只放索引）
3. **放在哪**（稳定前缀 / 后置易变段）
4. **何时移除**（截断 / 清理 / 压缩）

而 1–4 里真正有约束力的物理事实是：**provider 的前缀缓存只对"稳定前缀"命中。**
一旦你改动了前缀里的任何字节（system、工具 schema、历史消息），缓存从改动点之后
全部失效。于是所有机制的设计都在和"前缀稳定 vs 上下文太小"这对矛盾做权衡。

## 1. 分层机制表

| 层 | 机制 | 钩子问题 | 状态 |
|---|---|---|---|
| L0 | tool loop 状态机 | 一个 turn 的精确状态与停止条件 | M0 ✅ |
| L1 | system 装配 / 环境注入 / AGENTS.md | 什么必须进前缀、什么必须后置 | M0 ✅ |
| L2 | 缓存与 token 经济 | 谁在破坏前缀，代价多大 | M1 ✅ / L1 ✅ |
| L3 | 压缩 / tool-result clearing / memory | 压缩时保什么、缓存怎么处理 | M3 ✅ / M9 ✅ |
| L4 | skill（渐进披露） | 取 skill 正文为何不重写前缀 | M2 ✅ |
| L4 | MCP（tool/resource/prompt） | 工具 schema 何时注入、顺序为何有害 | M4 ✅（惰性方案见 M11） |
| L4 | hooks / slash commands | 生命周期注入点在哪 | M6 ✅ / M12 ✅ |
| L5 | subagent / 多 agent | 隔离上下文 + 结果回灌的成本模型 | M5 ✅ / M10 ✅ |
| L5 | background / scheduled | 非阻塞执行与定时触发 | M7 ✅ |
| L6 | session / fork / checkpoint | 会话边界、代码回滚与对话回滚解耦 | M6 ✅ / M8 ✅ |
| L7 | 权限 / 沙箱 | 每次决策在哪一层拦截 | M0 缝，M6 ✅，M12 ✅ |
| L8 | 观测台 / diff / cost | 如何让上下文可见 | M0 ✅ / L1 ✅ / L3 ✅ |

## 2. 深挖一：Skill 与 KV cache

**你原本的说法**："skill 取用不会影响 KV cache"。
**更准确的说法**：不是"取用不影响缓存"，而是 **skill 被拆成两半，元数据常驻前缀，
正文按需注入**，于是取正文时已缓存的前缀仍然有效。

**三级渐进披露**（Claude Skills 的真实设计）：

1. **元数据**（name + description）：永远可见，常驻 system prompt / 工具列表。
2. **正文**（`SKILL.md`）：只有当模型判断需要时才加载进上下文。
3. **引用文件**：正文里指到的文件，再进一步按需读取。

来源：[Towards Data Science: Claude Skills and Subagents](https://towardsdatascience.com/claude-skills-and-subagents-escaping-the-prompt-engineering-hamster-wheel)、
[Colin McNamara: Understanding Skills/Agents/Subagents/MCP](https://colinmcnamara.com/blog/understanding-skills-agents-and-mcp-in-claude-code)。

**为什么这样能省缓存**：元数据那层极小且稳定（几十 token），正文那层是"按需插入"，
一旦插入就位于消息数组的**尾部附近**，不会改动它之前已缓存的前缀。这就是
"progressive disclosure" 的成本模型：**用一次小额常驻开销，换取大量正文的惰性加载。**

**要回答的钩子问题**：

- skill 元数据放 system 还是放工具 schema？两者对缓存的影响不同。
- 正文以什么形式注入：一条 user 消息？一条 tool result？还是改写 system？
  （**改写 system = 破坏前缀；插入尾部消息 = 不破坏**——这是要对比的核心。）
- 禁用/启用 skill 时，是否会像 Codex 改工具集那样导致 cache miss？

**实验**：实现 skill 的两种注入方式（改写 system vs 尾部插入），分别跑两轮相同
请求，对比 `usage.prompt_tokens_details.cached_tokens`。预期：尾部插入法第二轮
命中；改写 system 法则从改动点起 miss。**未验证，待 M2 用真实数据定论。**

## 3. 深挖二：MCP 的上下文管理

**核心事实**：MCP 是**"急切"（eager）**的——所有已连接 server 的工具元数据，
都会在每轮请求里**全量注入**，无论是否用到。这带来两个后果：

1. **上下文成本**：接 5–20 个 server 就可能吃掉数万 token 的工具描述。
2. **缓存风险**：工具集的**枚举顺序**或**成员**一旦变化，前缀失效。

来源：[Developers Digest: Skills over MCP, progressive disclosure](https://www.developersdigest.tech/blog/skills-over-mcp-progressive-disclosure)
（"MCP is eager ... loads all tool metadata upfront"）、
[Towards Data Science](https://towardsdatascience.com/claude-skills-and-subagents-escaping-the-prompt-engineering-hamster-wheel)。

**Codex 的真实教训**（极重要，直接回答你的问题）：Codex 团队在加入 MCP 支持时
踩过一个 bug——**MCP 工具的枚举顺序不稳定**，导致 prompt cache 失效。此外他们
总结了会引发 cache miss 的几类变更：**改变可用工具集、换模型、改 sandbox 配置、
改审批模式、改 cwd**。他们的应对是：能追加就追加，绝不改写旧消息——
改审批模式时插入一条新的 developer 消息，改 cwd 时插入一条新的 user 消息。

来源：[ZenML LLMOps DB: OpenAI Codex CLI Architecture and Agent Loop Design](https://www.zenml.io/llmops-database/building-production-ready-ai-agents-openai-codex-cli-architecture-and-agent-loop-design)。

**由此推出的 MCP 设计原则**（本项目要落实的）：

- 工具 schema 注入必须**确定性排序**（我们已在 `ToolRegistry.list()` 里按名字排序）。
- 动态增删 MCP 工具时，等价于改工具集 → 会 miss。要么接受，要么用"工具搜索"
  之类的惰性方案（例如**在沙箱里生成代码去调用工具**，把 N 个工具描述压成 1 个）。
- MCP 的 `resources` / `prompts` 与 `tools` 的注入时机不同，要分别测。

**要回答的钩子问题**：

- 加一个 MCP server 前后，`cached_tokens` 掉多少？掉在哪一段？
- 工具描述在 system 里还是在 `tools` 数组里，对缓存的影响是否相同？
- "工具搜索" / 代码执行式调用，能把这部分上下文压到多少？

## 4. 深挖三：压缩（compaction）

**真实实现线索**（Claude Code，来自逆向分析）：`compactConversation()`
（`compact.ts`）有几个关键设计：先触发 `PreCompact` hook（允许注入自定义指令）；
一个 feature flag 决定压缩路径**是否复用主会话的 prompt cache**，代码注释记录了
2026 年 1 月的实验——**"false 路径（不复用）是 98% cache miss，且只占全网
cache creation 的 0.76%"**；压缩后，attachment builders 会**重新宣告运行时状态**
（plans、skills、async agents）。

来源：[arXiv 2604.14228, Dive into Claude Code](https://arxiv.org/html/2604.14228v1)。

**这回答了什么**：压缩本身就意味着"改写历史前缀"，与缓存天然冲突；真实产品的
权衡是"要不要为省缓存而让压缩复用缓存路径"。这是本项目最好的一个实验：
**压缩必然 miss 吗？有没有办法让压缩后的前缀重新稳定下来？**

**要回答的钩子问题**：

- 压缩后第一轮的 `cached_tokens` 是多少？第二轮是否恢复命中？
- 压缩摘要如果放在**固定位置**（而非拼进历史），能否重新建立稳定前缀？
- tool-result clearing（只丢工具结果正文、保留调用记录）对缓存与推理质量的
  影响，与整段压缩相比如何？

## 5. 其余机制的钩子问题（简表）

| 机制 | 要回答的问题 |
|---|---|
| AGENTS.md / memory | 发现顺序、父子目录合并、注入位置；改动记忆是否炸缓存 |
| subagent | 子上下文如何初始化、结果如何回灌、主上下文省了多少 token |
| background/scheduled | 非阻塞执行如何不污染主 turn；定时触发的状态从哪读 |
| checkpoint/fork | 对话回滚与代码回滚为何解耦；fork 后缓存怎么算 |
| hooks | PreToolUse / PostToolUse / PreCompact 的拦截语义 |
| 权限 / 审批 | 裁决发生在工具执行前的哪一层；`ask` 如何变成被 await 的人机决策（M12） |
| slash commands | 命令是输入预处理还是模型能力；注入点在前缀还是尾部（M12） |
| 观测台 | 哪些事件足以重建"模型看到了什么" |

## 6. 待验证问题清单（本项目的产出）

1. skill 正文的三种注入方式，各自的 `cached_tokens` 曲线。（M2）
2. 增删一个 MCP server 对缓存的具体影响与代价。（M4）
3. 压缩后缓存恢复曲线；固定位置摘要 vs 拼进历史。（M3）
4. 工具排序抖动导致 miss 的复现。（M1，最小实验）
5. subagent 回灌 vs 主上下文直做的 token 账。（M5）

> 每解决一条，就在对应里程碑的机制文档里补上**实测数据**与结论。

> **结清**：1–5 全部由 M1–M5 用真实 `usage` 定论（见 §7），另有 M9/M10/M11/M12
> 的延伸结论也已回填。速览见 [`docs/MYTHS.md`](MYTHS.md)；逐章学习路径见
> [`docs/LEARNING.md`](LEARNING.md)。

## 7. 实测结论（回填）

> 本节结论的"**常识 vs 实测**"速览版见 [`docs/MYTHS.md`](MYTHS.md)（每条都指向对应 run 文档）。

### M1 缓存与 token 经济 — 详见 [`runs/m1-cache.md`](runs/m1-cache.md)

模型：`xiaomi/mimo-v2.6-flash`（走自动前缀缓存，`cache_write_tokens` 恒为 0）。

| 变量 | 实测结果 | 判定 |
|---|---|---|
| 相同请求 ×4 | 第 2 次起 `cached=3328/3371`（98.7%） | 前缀缓存可用 |
| **反转 tools 数组顺序** | `cached` 3328 → **0**（3/3 复现） | §3 **confirmed** |
| 追加 1 个工具（prompt +83） | `cached` → 0–512，代价 ~34–40× 新增字节 | §3 **confirmed** |
| system 改 1 byte | `cached` → 512（丢 84.6%） | §2 **confirmed** |
| append-only 只追加 | `cached` 恒定 3328（hit% 只随分母缓降） | §0/§2 **confirmed** |

政策含义（已落到实现与路线图）：

1. 工具 schema **绝不重排、绝不动态增删** → `ToolRegistry.list()` 按名稳定排序。
2. system 前缀只增不改，易变内容（cwd 列表、最新 tool result）后置。
3. 历史只追加；确需重置时，最多再预热 1 次相同调用即可恢复命中。

成本：`mimo-v2.6-flash` 冷调用 `$0.000375`、命中 `$0.000309`（约 **-18%**）。

### M3 上下文压缩 — 详见 [`runs/m3-compaction.md`](runs/m3-compaction.md)

压缩把 prompt 从 **30917 → 4808**（−84.4%）。**压缩必然付一次全量 re-warm**：压缩后第 1 次
`cached=0`，第 2 次相同请求回到 ~98.5%。摘要位置很关键：**拼进历史**保留共享头 4608 token，
**固定首槽**只保留 512（Δ=4096）——即"把摘要当作历史的一部分重写"比"另起一个固定槽位"更省缓存。
`clearToolResults` 回收 50.1%（弱于 compact 的 84.4%），但恢复后命中 99.4%。

### M6 权限/hooks/checkpoint — 详见 [`runs/m6-permissions.md`](runs/m6-permissions.md)

HookRunner + 有序规则 + 统一 `decide()`（allow/ask/deny/mutate）；checkpoint 字节级还原
12/12 通过。**这是实现类里程碑，不涉及缓存实验。**

### M7 后台/定时 — 详见 [`runs/m7-scheduler.md`](runs/m7-scheduler.md)

Scheduler / `runInBackground` / 结果回灌；全部断言通过。**实现类里程碑，零 API 调用。**

### M2 Skills 渐进披露 — 详见 [`runs/m2-skills.md`](runs/m2-skills.md)

正文用**尾部 user 消息 / tool result** 注入：`cached` 保持 3456，follow 调用达 99.5%；
**改写 system 前缀**：`cached` 塌到 640。修正 §2 的措辞：不是"改 system 就失效"，
而是"**非追加地改动已缓存前缀**才失效"——把内容**追加到 system 尾部**等价于尾部消息，
并不破坏缓存。

### M4 MCP 上下文 — 详见 [`runs/m4-mcp.md`](runs/m4-mcp.md)

手写 stdio JSON-RPC 客户端跑通 `initialize`/`tools/list`/`tools/call`。N 个急切注入的
工具约 **165 token/个**（N=20 在 2842 基线上 +3300）；**加 1 个工具 `cached` 3328→0**，
重排同一集合 3456→0，**放大 ~16–20×**。

### M5 Subagent — 详见 [`runs/m5-subagent.md`](runs/m5-subagent.md)

委派把父上下文最终 `prompt_tokens` **9420 → 858（−90.9%）**；总 token +15.5%、
成本 +18.8%。隔离用"总 token 略增"换取"主上下文大幅缩小"。

### M9 记忆（memory）— 详见 [`runs/m9-memory.md`](runs/m9-memory.md)

跨会话：会话 A 经 `memory` 工具存 3 条事实后，全新的会话 B（另一个 `Agent`、
空历史、只共享磁盘目录）调用 `memory search` 答出 `"Blue Lantern"`——该字符串只
存在于 A 写入的 NDJSON 里。缓存注入位置（同一 437-char 记忆块、每型 3 次相同请求）：

| 注入位置 | 相对预热 cached | 判定 |
|---|---|---|
| system 前缀**内部**（改写） | 3648 → **0**（inject#1） | 前缀全失效，付一次全量 re-warm |
| 消息数组**尾部**（tool result） | 3584 → **3584**（逐字节不变） | 前缀保留，只新增尾部未命中 |

结论：**改记忆不必然炸缓存**，只取决于注入位置；检索结果一律作为尾部 tool result。
`pnpm typecheck` 全绿；共 14 次 API 调用。

### M10 orchestrator — 详见 [`runs/m10-orchestrator.md`](runs/m10-orchestrator.md)

Run B（3 个读大文件微任务）：coordinator 主上下文 `prompt_tokens` **8793 → 1926
（−78.1%）**，答案完全一致；全链路总 token 9829 → 21970（**+123%**）、成本
$0.001190 → $0.002615（**+120%**）。Run A 小任务反例：coordinator 1386 → 1907
（**+37.6%**）——隔离只有在"原始输出 ≫ worker 固定开销"时才划算。question/reply/ack
实录显示 worker `blocked → running` 的恢复点；未 ack 投递重放 7/7 断言通过（0 次
API）；5 个 session id 互不相同、无跨上下文泄漏。单次完整运行约 16 次调用。

### M11 惰性工具暴露（tool-search）— 详见 [`runs/m11-tool-search.md`](runs/m11-tool-search.md)

N=25 个真实工具下，常驻前缀 **4777 → 3100（−1677，−35.1%）**，边际 ≈73 token/工具
（按 M4 的 ~165 token/工具外推，真实 MCP 工具节省更大）。请求一字未改时两模式都能
稳定命中（eager 峰值 99.1% / lazy 98.1%）；lazy 任务总 token **−41.3%**、成本
+9%（多一次 `tool_search` 往返）。索引确定性（原序 vs 反转序逐字节相同）PASS。
结论：工具多、单轮只用少数且会话较长时走 lazy；否则 eager 更直接。

### M12 交互式审批 + 斜杠命令 — 详见 [`runs/m12.md`](runs/m12.md)

`ask` 从"乐观放行/阻断"升级为**被 await 的真实决策**：gate 判 `ask` 时发
`approval.requested`、阻塞在 `AgentConfig.approvals` 回调、发 `approval.resolved`
后执行或回灌拒绝。真实模型实验：deny 腿事件序列
`tool.call → permission.decision → approval.requested → approval.resolved`（无
`tool.result`，文件不生成）；allow 腿同序再 `tool.result`，文件字节
`M12-ALLOW-…`（14B，sha256 `f493a861…`）。回调里 `sleep(250ms)` ⇒ 两次
`Δ≈263ms`，**证明循环确实停在 promise 上**。服务器：`POST …/approvals`
（404/409/400）+ `APPROVAL_TIMEOUT_MS`（实测 ~1513ms 超时 resolve `deny`，文件不生成）。
斜杠命令 `/help` `/memory` `/workers` `/compact` 命中时**零模型 turn**（SSE 仅
`mechanism(command)+assistant.message+turn.end`）；`/etc/hosts`、`/foo` 非命令，原样
进模型（`context.compiled`）。两条路径都只**追加**消息，未配置路径与 master 逐字节一致；
无新依赖。
