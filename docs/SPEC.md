# agent-things — 项目规格 (SPEC)

## 1. 为什么做这个

起点是立党那条 post（见 `original_request.md`）：本科生该做的三节课——
买 coding plan 用上 claude-code / codex；自己写一个最小 coding agent；然后
逐个把 memory、skills、subagent、background、session、context compression、
TUI/GUI、diff、权限等机制摸索出来。

本项目对应**第二节课 + 第三节课**。动机不是"再造一个通用 agent"，而是：
**我们对很多机制的具体实现并不真正理解**，尤其是：

- skill 按需加载为什么不破坏（或如何逼近不破坏）KV cache？
- MCP 的上下文管理机制到底是什么？工具 schema 何时、以何种顺序注入？
- 压缩（compaction）在多大程度上保留缓存、保留什么？

这些东西的答案不在"能跑起来"，而在"能在真实 API 的用量数据上被观测并解释"。
所以本项目是一个**教学型实现**：每一层机制都要能被实现、被观测、被讲清楚。

## 2. 目标 / 非目标

**目标**

1. 一个能跑的最小 coding agent：输入一个任务，能 iteratively 读代码、改代码、
   跑编译/测试，并把结果回灌给模型继续。
2. 每一层机制都有：可运行实现 + 事件流观测 + 一篇能让别人学会的机制文档。
3. 把"无形的上下文"变成**可见的数字**：token、缓存命中、注入点、工具往返。

**非目标**（至少 M0–M3 内）

- 不追求功能对齐 claude-code / codex 的产品完整度。
- 不追求生产级的健壮性、并发、安全沙箱。
- 不做移动端 / 多人协作 / 云端部署。
- 不引入会**隐藏机制**的抽象（见 §6 设计原则）。

## 3. 什么叫"搞懂了"（验收，软要求）

用户明确表示验收不是硬要求（"既然都直接做了，验收其实也不重要"）。但为了
避免"机制自我欺骗地滑过去"，本项目采用三条软标准，机制文档里至少满足其一：

1. **可测量**：用真实 API 的 `usage`（`cached_tokens` / `cache_write_tokens`）
   做实验，用数据解释行为，而不是引用二手说法。
2. **可复现**：不看现成实现，从零写出该机制的最小版本并能跑。
3. **可讲清**：写出一份别人照着能学会、能复现的讲解。

## 4. 已定决策（来自需求盘问）

| 维度 | 决策 | 理由 |
|---|---|---|
| 第一优先级 | 边实现边讲机制的教学型 agent | 只跑通会滑过第三节课 |
| 语言/运行时 | TypeScript / Node | 与 claude-code、opencode 同栈，便于对照源码 |
| 模型接入 | OpenRouter，**手写客户端** | 要看清请求体、缓存标记、工具 schema 的原始形态 |
| 界面 | **Web 优先**（后台是重点），CLI 是副产物 | 终端难调试；web 的价值是把上下文做成可观测面板 |
| 仓库结构 | pnpm monorepo：`packages/core` + `packages/server` + `apps/web` | 内核与传输解耦 |
| 持久化 | SQLite（`node:sqlite` 内置）+ 事件日志 | 免原生编译，事件可回放 |
| 验收 | 可被他人学会的文档 | 软要求 |

## 5. 相对 post 的补全

post 的清单缺了几块，本项目补入（详见 `docs/MECHANISMS.md`）：

- **缓存与 token 经济**：前缀稳定性、`cache_control`、provider sticky routing、
  用量观测。（post 完全没提）
- **工具结果的处置**：tool-result clearing / 截断。
- **checkpoint / rewind**：会话与代码的独立回滚。
- **scheduled tasks** 与 **hooks** 生命周期。
- **子 agent 的上下文隔离与结果回灌** 的成本模型。

## 6. 设计原则

1. **一切皆上下文**：工具、记忆、skill、MCP、子 agent 的产物，本质都是往
   消息数组里放东西。区别只在"何时放、放多少、放在前缀还是后置"。
2. **前缀稳定**：绝不修改历史，只追加。稳定的内容（system、工具 schema、记忆）
   在前，易变的（cwd 列表、最新 tool result）在后。这是缓存能命中的前提。
3. **可观测优先**：事件流是产品的核心，不是日志。任何机制若不可观测，就不算实现完。
4. **传输与内核解耦**：`Agent.run()` 是 async generator，产出事件；HTTP/SSE 只是
   一种消费者。桌面/CLI 未来复用同一内核。
5. **手写而非封装**：关键路径（模型客户端、消息装配、工具循环）不引 SDK。
   便利库可以在验证过机制之后再考虑。
6. **接口先冻再并行**：并行开发前先冻结 `AgentEvent` 与 HTTP 契约
   （`docs/CONTRACT.md`），各机制在独立 worktree 上并行。

## 7. 安全与边界

M0 权限层是**非交互的**（`yolo` / `standard` / `readonly` 三档），只建立
"闸门在哪"的缝，不做交互审批。文件工具限制在 `AGENT_CWD` 内，拒绝路径逃逸。
生产级沙箱（seatbelt / landlock / 容器）明确不在范围内。
