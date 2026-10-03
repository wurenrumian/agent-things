# 实验记录 — M5 子 agent 与上下文隔离

**日期**：2026-10-03
**模型**：`xiaomi/mimo-v2.6-flash`（OpenRouter）
**命令**：

```bash
pnpm --filter @agent/server exec tsx scripts/subagent-experiment.ts
# 或分腿跑：... subagent-experiment.ts inline / delegated
```

> 复现方式：worktree `m5-subagent` 里从主 worktree 复制 `.env`（gitignored，未提交），
> `pnpm install` 后执行上面的命令。脚本绕开 HTTP server，直接经 `OpenRouterClient`
> 打到 OpenRouter，所以两次运行之间唯一变化的就是 request body。

**环境**：温度 0，`maxSteps=8`，`permissionMode=yolo`，模型名在脚本内固定为
`xiaomi/mimo-v2.6-flash`（不读 `.env` 的 `OPENROUTER_MODEL`，保证与约束一致）。
出现 HTTP 429 时按 `2s / 4s / 6s` 退避重试整条腿。本次运行共 **6 次** provider 调用
（inline 2 + delegated 4），远低于 ~20 次预算，未触发 429。

## 0. 方法

同一条调查任务：读 4 个源文件（`agent/loop.ts`、`provider/openrouter.ts`、
`context/system-prompt.ts`、`tools/builtin.ts`，合计约 860 行），再用 ≤120 词总结
它们如何协作。用两种方式执行：

- **(a) inline**：主 agent 自己持有 `builtinTools()`，用 `read_file` 读全部 4 个文件；
  每个 `tool` 结果（完整文件正文）都追加进主消息数组。
- **(b) delegated**：主 agent 只持有 `task` 工具，调用一次 `task`；`execute()` 内部
  起一个**全新 `Agent`**（自带 message 数组 + 自带 system prompt，工具集 = builtin
  去掉 `task`）跑完任务，只把**最终 assistant 文本**作为 tool result 回灌。

每次调用读取真实的 `usage`（`prompt_tokens` / `completion_tokens` /
`prompt_tokens_details.cached_tokens` / `cost`）。两个指标：

- **parent final prompt_tokens** = 主 agent **最后一次**请求的 `prompt_tokens`，
  即“主上下文大小”。
- **all-calls total / cost** = 父 + 子所有调用的 `total_tokens` / `cost` 之和。

## 1. 实测数据

### 1.1 (a) inline — 主上下文自己吞下所有工具输出

| call | prompt | completion | cached | cost($) |
|---|---|---|---|---|
| 1 | 856 | 100 | 0 | 0.000122 |
| 2 | **9420** | 168 | 768 | 0.001068 |
| **合计** | 10276 | 268 | 768 | **0.001190** |

主 agent 在第 1 步并行发起 4 个 `read_file`，第 2 步带着 4 份完整文件正文总结。
**parent final prompt_tokens = 9420**，总 token 10544、成本 $0.001190、2 次调用。

### 1.2 (b) delegated — 主上下文只收到最终摘要

| 来源 | prompt | completion | cached | cost($) |
|---|---|---|---|---|
| parent call 1 | 563 | 168 | 0 | 0.000109 |
| parent call 2 | **858** | 161 | 512 | 0.000129 |
| **parent 合计** | 1421 | 329 | 512 | **0.000238** |
| child call 1 | 802 | 102 | 0 | 0.000117 |
| child call 2 | 9366 | 158 | 768 | 0.001059 |
| **child 合计** | 10168 | 260 | 768 | **0.001176** |
| **all calls** | 11589 | 589 | 1280 | **0.001414** |

主 agent 第 1 步调用 `task`，第 2 步带着子 agent 的摘要收尾。
**parent final prompt_tokens = 858**；全链路总 token 12178、成本 $0.001414、4 次调用。

### 1.3 token 账

| run | parent final prompt_tokens | parent total | child total | all-calls total | all-calls cost($) |
|---|---|---|---|---|---|
| a-inline | **9420** | 10544 | — | **10544** | 0.001190 |
| b-delegated | **858** | 1750 | 10428 | **12178** | 0.001414 |

- **主上下文节省**：9420 → 858，省 **8562 prompt_tokens（−90.9%）**。这是子 agent
  隔离的核心收益：子 agent 自己那 9366 token 的工作上下文（几乎和 inline 主上下文
  一样大）**完全没有进入主上下文**。
- **全链路总 token**：10544 → 12178，delegation **多花 1634 token（+15.5%）**；
  成本 $0.001190 → $0.001414，**多 18.8%**。这是隔离的代价：子 agent 要重建一份
  system prompt + 工具 schema，并且 4 个文件被读了两遍（一次在子 agent 内）。
- 两种方式产出的最终摘要质量相当（都完整覆盖 loop / provider / system-prompt /
  builtin 四者的关系），说明“只回灌最终文本”没有牺牲答案。

> 关键洞见：**delegation 优化的不是总 token，而是主上下文。** 它把“一次性、可丢弃的
> 工作噪音”从长期存活的主消息数组里挪走，用一次性总 token 的小幅上升（+15%）换取
> 主上下文的大幅缩小（−91%）。主上下文越小，后续每一个 turn 的 `prompt_tokens`、
> 缓存失效代价、以及压缩压力都越低——收益随对话轮数复利增长。

## 2. 结论（对照 `docs/MECHANISMS.md` §6）

| §6 问题 | 归属 | 判定 | 依据 |
|---|---|---|---|
| **5. subagent 回灌 vs 主上下文直做的 token 账** | M5 | **confirmed，已量化** | §1.3：主上下文 9420 → 858（−90.9%）；全链路总 token +15.5% / 成本 +18.8% |

**对 MECHANISMS §5「subagent：子上下文如何初始化、结果如何回灌、主上下文省了多少 token」的回答：**

1. **子上下文如何初始化**：`runSubagent()` 起一个**全新 `Agent`**——独立 message 数组
   （构造函数默认空）、独立 system prompt（本实现用专用的
   `SUBAGENT_SYSTEM_PROMPT` 覆盖默认主 system prompt），工具集 = `builtinTools()`
   去掉 `task`（防递归）。子 agent 有自己的 `session_id`，因此前缀缓存独立结算。
2. **结果如何回灌**：`task` 工具的 `execute()` 消费子 agent 的 `AgentEvent` 流，只取
   **最后一条非空 assistant 文本**作为 `ToolResult.output`。父循环把它作为一条
   `role:"tool"` 消息追加进主消息数组——**子 agent 的中间 tool 输出从不进入父上下文**。
3. **主上下文省了多少 token**：本实验 **8562 prompt_tokens（−90.9%）**。

## 3. 何时 delegation 划算

由 §1.3 的数据推出成本模型（可直接用作工程判据）：

- 子 agent **必然重复**一份固定开销：自己的 system prompt + 工具 schema（本实验里
  child call 1 的 802 token 大部分是它）。所以**调查本身产生的可丢弃输出太小时，
  delegation 是净亏**。
- 只有当“工具的原始输出 ≫ 子 agent 的固定开销”时，隔离才在大账上划算：
  本实验工具输出约 8.5k token，远超 child 固定开销，于是主上下文省了 8.5k；
  但全链路仍因重复读 + 重复前缀而多花 1.6k。
- 判据：**delegation 的价值 = “省下的主上下文” × “该上下文要在后续多少个 turn 里
  继续被付钱/被缓存”**。一次性、之后不再需要的调查 → 适合下放；主 agent 后续
  每轮都要带着这份上下文（`prompt_tokens` 永久变大、缓存失效/压缩代价更高）→
  下放的复利收益更大。
- 反例：任务需要与主 agent 来回交互、或结论需要大量原文细节时，下放会丢失上下文，
  反而要重新读取。

## 4. 约束遵守

- 只新增 4 个 Target 路径下的文件；**未修改** `packages/core/src/**` 任何已有文件、
  `packages/server/src/**`、`apps/web/**`、任何 `package.json`、`docs/CONTRACT.md`
  / `MECHANISMS.md` / `ROADMAP.md`。
- **未加依赖**：机制只用 Node 内置 + 已有 core 代码。
- `.env` 仅工作区本地复制，`.gitignore` 覆盖，未提交。
- `pnpm typecheck` 全包 green。
- API 调用 6 次（预算 ~20）；无 429。

## 复现

```bash
cp D:/Project/agent-things/.env ./.env      # gitignored
pnpm install
pnpm --filter @agent/server exec tsx scripts/subagent-experiment.ts
# 分腿：... subagent-experiment.ts inline
#       ... subagent-experiment.ts delegated
pnpm typecheck
```

代码位置：

- 机制：`packages/core/src/mechanisms/subagent/index.ts`
  （`runSubagent` / `createTaskTool` / `subagentTools` / `summarizeUsage`）
- 实验：`packages/server/scripts/subagent-experiment.ts`
- 教学文档：`docs/mechanisms/subagent.md`
