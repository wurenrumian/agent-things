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
| L2 | 缓存与 token 经济 | 谁在破坏前缀，代价多大 | M1 |
| L3 | 压缩 / tool-result clearing / memory | 压缩时保什么、缓存怎么处理 | M3 |
| L4 | skill（渐进披露） | 取 skill 正文为何不重写前缀 | M2 |
| L4 | MCP（tool/resource/prompt） | 工具 schema 何时注入、顺序为何有害 | M4 |
| L4 | hooks / slash commands | 生命周期注入点在哪 | M6 |
| L5 | subagent / 多 agent | 隔离上下文 + 结果回灌的成本模型 | M5 |
| L5 | background / scheduled | 非阻塞执行与定时触发 | M7 |
| L6 | session / fork / checkpoint | 会话边界、代码回滚与对话回滚解耦 | M6 |
| L7 | 权限 / 沙箱 | 每次决策在哪一层拦截 | M0 缝，M6 完整 |
| L8 | 观测台 / diff / cost | 如何让上下文可见 | M0 ✅ |

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
| 权限 | 裁决发生在工具执行前的哪一层；拒绝如何回灌给模型 |
| 观测台 | 哪些事件足以重建"模型看到了什么" |

## 6. 待验证问题清单（本项目的产出）

1. skill 正文的三种注入方式，各自的 `cached_tokens` 曲线。（M2）
2. 增删一个 MCP server 对缓存的具体影响与代价。（M4）
3. 压缩后缓存恢复曲线；固定位置摘要 vs 拼进历史。（M3）
4. 工具排序抖动导致 miss 的复现。（M1，最小实验）
5. subagent 回灌 vs 主上下文直做的 token 账。（M5）

> 每解决一条，就在对应里程碑的机制文档里补上**实测数据**与结论。
