# 机制：subagent（子 agent 与上下文隔离）

> 实测数据见 [`../runs/m5-subagent.md`](../runs/m5-subagent.md)。
> 代码：`packages/core/src/mechanisms/subagent/index.ts`。

## 1. 一句话

**subagent = 起一个全新的 `Agent`，把「会产生大量一次性输出」的工作丢进它的私有
消息数组里，只把它最后那句结论取回来。** 父上下文因此只增大“结论”那么大，而不是
“整个过程”那么大。

回到 §0 的心智模型：agent 的能力是“在正确时机把正确字符放进消息数组”。subagent
回答的是**“何时移除 / 放多少”**这一维——它不是往主上下文里加东西，而是**一开始
就不让这些东西进来**。

## 2. 为什么它能省上下文：隔离的物理事实

主 agent 的上下文是被 provider **每一步都重新计费**的：一个 turn 里每多一次工具
调用，下一轮请求的 `prompt_tokens` 就永久变大；而且它是**追加**的（append-only），
除非压缩，否则不会缩小。所以“读 10 个文件”这类调查会让主上下文永久背上这 10 份
文件正文。

subagent 把这段工作放进**另一个消息数组**：

```
parent context ── task(prompt) ──▶ child Agent（独立 messages + 独立 system prompt）
     ▲                                        │
     └──── tool result = 最终 assistant 文本 ◀─┘
                  （子 agent 的中间 tool 输出全部丢弃）
```

- 子 agent 拥有**自己的 message 数组**：工具输出进的是它，不是父。
- 子 agent 拥有**自己的 system prompt**：本实现用专用的 `SUBAGENT_SYSTEM_PROMPT`
  （“你是被父 agent 通过 task 工具调起的 worker，父只能看到你的最终回复，别把原始
  文件正文贴回来”）。这段隔离指令本身就是让回灌变小的关键。
- 子 agent 有**自己的 `session_id`**：它的前缀缓存与父分开结算，不会污染父的缓存路由。
- 子 agent 的工具集 = builtin **去掉 `task`**：递归护栏，也让它自己的工具 schema
  前缀保持稳定、不含 task 定义。

## 3. 实现

`runSubagent(opts)` 返回一个完整的运行账本；`createTaskTool(opts)` 把它包成父 agent
可以注册的 `ToolDef`。核心就三件事：

```ts
// 1. 全新 Agent：独立 messages + 独立 system prompt
const agent = new Agent({
  client, model, tools: registry, cwd,
  permissionMode, maxSteps, temperature,
  systemPromptOverride: SUBAGENT_SYSTEM_PROMPT,   // 子上下文自带 prompt
}, sessionId);

// 2. 跑到底，只收集 usage 与“最后一条非空 assistant 文本”
for await (const event of agent.run(prompt, signal)) {
  if (event.type === "usage") usages.push(event.usage);
  if (event.type === "assistant.message" && /* content 非空 */) finalText = content;
}

// 3. task 工具的 execute() 只把 finalText 作为 ToolResult 返回
return { output: finalText };
```

父循环那边无需任何改动：`Agent.executeToolCall()` 会把 `ToolResult.output` 作为一条
`role:"tool"` 消息追加。于是“结果回灌”天然只是**一条消息、一个字符串**。

### 防递归

`subagentTools()` = `builtinTools()` 中过滤掉 `task`。子 agent 因此**无法再起子
agent**。这是有意的：无限递归会烧掉调用预算，也会让“谁在什么上下文里”变得不可观测。

### 权限

`task` 工具标 `readOnly: true`（父侧只是一个委派动作），但它把父的 `permissionMode`
**透传**给子 agent，子 agent 的写操作仍然受同一套权限裁决约束。实验里父/子都用
`yolo`，但接口支持 `standard` / `readonly`。

## 4. 成本模型：isolate 省的是主上下文，不是总 token

实测（`xiaomi/mimo-v2.6-flash`，读 4 个文件并总结，详见 run 文档）：

| | inline | delegated |
|---|---|---|
| parent final `prompt_tokens` | 9420 | **858**（−90.9%） |
| all-calls total tokens | 10544 | 12178（+15.5%） |
| all-calls cost | $0.001190 | $0.001414（+18.8%） |

两个方向的账要分开看：

- **主上下文**：9420 → 858。子 agent 那 9366 token 的工作上下文被整段丢弃。
- **全链路总量**：反而 +15.5%。因为子 agent 要**重建一份固定开销**（system prompt +
  工具 schema），且被调查的文件**被读了两遍**。

所以判据不是“总 token 省没省”，而是：

> **delegation 的价值 =（省下的主上下文）×（这份上下文原本还要在后续多少个 turn
> 里被继续付费 / 继续占据缓存 / 继续增加压缩压力）。**

一次性、事后不再需要的调查：适合下放，但只有当**工具原始输出 ≫ 子 agent 固定开销**
时才在大账上划算。需要与主 agent 反复交互、或结论依赖大量原文细节的任务：下放反而
要重新读取，不划算。

## 5. 与 prompt cache 的关系

- 每个 subagent 是独立 `session_id`，独立前缀缓存。**不要**让子 agent 复用父的
  session_id，否则两套前缀互相打断。
- 子 agent 的 system prompt + 工具 schema 在它自己的多次调用之间是**稳定前缀**，
  第二跳通常能吃到大额缓存命中（实测 child call 2 `cached=768`）。
- 主上下文因为 delegation 变小，后续每个 turn 的 `prompt_tokens` 也更小；且由于父
  从不追加子 agent 的中间输出，父前缀依旧只追加、不改写，缓存友好（呼应 M1 的
  append-only 结论）。

## 6. 什么时候该用 / 不该用

**该用：**

- 调查类任务：读很多文件 / 搜索 / 大范围扫描，只需要一个摘要。
- 输出会被丢弃：中间过程不影响主任务，结论才重要。
- 主上下文已经很长，再塞就会触发压缩或显著变贵。

**不该用：**

- 任务小、子 agent 的固定开销比工具输出还大 → 净亏。
- 需要与父来回澄清、或要把中间观察留给后续 turn 用 → 隔离会丢信息。
- 强顺序依赖的编辑类工作 → 交给同一个上下文更安全。

## 7. 边界与后续

- 本实现是**同步**的：`task.execute()` 阻塞到子 agent 跑完。非阻塞 / 后台 subagent
  属于 M7。
- 子 agent 的中间输出目前只体现在运行账本（`SubagentRun.usages` / `toolCalls`）里，
  用于实验观测；接进观测台是合并后的独立一步（机制通过注册工具接入，不改循环）。
- 未做：子 agent 结果的结构化（JSON）回灌、多子 agent 并发、子 agent 之间共享缓存。
