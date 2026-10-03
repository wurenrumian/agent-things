# 机制：压缩与上下文回收（compaction & context reclamation）

> 对应 MECHANISMS 的 L3「压缩 / tool-result clearing / memory」。实现位于
> `packages/core/src/mechanisms/compaction/`，实验数据见
> [`../runs/m3-compaction.md`](../runs/m3-compaction.md)。

## 1. 一句话

压缩不是“删掉旧消息”，而是**对消息数组做一次纯粹的回收变换**：要么把中间一段折叠成一条
摘要，要么把旧工具结果的正文换成占位符而保留调用结构。它**不碰 agent loop**，只在步骤
之间被调用——策略（何时、保留多少、谁来摘要）属于调用方，变换本身是可测、可组合的纯函数。

## 2. 为什么需要它

Agent 的上下文会被两样东西撑爆：**工具输出**和**对话长度**。而 provider 的前缀缓存只在
“稳定前缀”上命中（M1：system 改 1 byte 丢 84.6%；M2：尾部追加不掉、前缀内改写全掉）。
于是回收和缓存形成一对矛盾：

- 回收需要**缩短 / 改写**历史 → 破坏已缓存前缀；
- 缓存需要**只追加** → 上下文只涨不缩。

压缩就是在这对矛盾里做选择，而它的缓存代价是可以量化的（§6）：**压缩后必付一次重预热，
但摘要放哪决定了此后能续用多少缓存。**

## 3. 两个原语

两个函数都接收 `ChatMessage[]`，返回**新数组**，绝不修改入参。系统前缀（开头的 `system`
消息）永远不动。

### 3.1 `compact(messages, { keepRecent, summarize })`

把中间一段折叠成一条摘要消息，保留最近 `keepRecent` 条原文。

```
[system…] [leading…] [        middle        ] [recent tail…]
              keepLeading   -> summarize <-      keepRecent

spliced:  [system…] [leading…] [summary] [recent tail…]   ← 默认
leading:  [system…] [summary]  [leading…] [recent tail…]
```

- `summarize: (messages) => string | Promise<string>` **由调用方注入**：可以是真实模型调用，
  也可以是测试桩。原语只负责切分与拼接。
- `keepLeading`（可选，默认 0）：保留中间之前的若干条原文（例如原始任务说明）。
- `placement`（可选）：`"spliced"`（默认，原地替换）或 `"leading"`（钉在紧随 system 的
  固定前导槽位）。
- `compactDetailed()` 返回同样的结果，外加 `summarized / keptLeading / keptRecent /
  summaryIndex` 等可观测字段。

### 3.2 `clearToolResults(messages, { keepLastN })`

只把**旧**的 `role:"tool"` 消息**正文**换成占位符，保留 `tool_call_id` 信封。

```
前: [assistant{ tool_calls:[call_0] }] [tool{ id:call_0, content: 9KB }]
后: [assistant{ tool_calls:[call_0] }] [tool{ id:call_0, content: "[cleared…]" }]
```

**为什么不能直接删**：OpenAI/OpenRouter 的 transcript 要求每个
`assistant.tool_calls[].id` 都有配对的 `role:"tool"` 消息。删掉 tool 消息会让会话非法；
所以回收只能换正文、不能拆信封。模型仍能看到“这个调用发生过”，必要时可以重跑。

`clearToolResultsDetailed()` 额外返回 `cleared / kept / charsSaved /
estimatedTokensSaved`。

### 3.3 `validateToolTranscript(messages)`

两个原语都必须产出**仍然合法**的 transcript。`validateToolTranscript` 返回结构问题列表
（空数组 = 合法）：未知 / 重复 / 悬空的 `tool_call_id`。`isToolTranscriptValid()` 是布尔
包装。实验的无 API 自检就用它证明：`compact` 整对删除、`clearToolResults` 只改正文，都不
破坏配对。

## 4. 代码 API（`mechanisms/compaction/`）

```ts
import {
  compact, compactDetailed, clearToolResults, clearToolResultsDetailed,
  validateToolTranscript,
} from "../../core/src/mechanisms/compaction/index.js";

// 压缩：中间折叠成摘要，保留最近 6 条；任务那一条保留在摘要之前
const next = await compact(messages, {
  keepRecent: 6,
  keepLeading: 1,
  placement: "spliced",
  summarize: async (middle) => {
    // 真实模型调用、或任意确定性桩
    return await summarizeWithModel(middle);
  },
});

// 回收：清掉最早的工具结果正文，保留最后 4 条
const lean = clearToolResults(messages, { keepLastN: 4 });

// 证明结果合法
if (validateToolTranscript(lean).length > 0) throw new Error("invalid transcript");
```

两个原语都是幂等友好的：对已经 clearing 过的数组再 clearing，正文已经是占位符，`charsSaved`
为 0；对已经很短的数组 `compact`，若 `middle` 为空则原样返回一份浅拷贝。

## 5. 接入一个 agent（合并阶段的接线方式）

1. **不修改循环**：在 `Agent` 产出 `assistant.message` 之后、下一次 `compileMessages()`
   之前，调用方（server / 宿主）决定是否回收。原语接收当前 message 数组、返回新数组。
2. **`clearToolResults` 放在每步或每 N 步**：它无损于结构，最适合做“常规节流”。
3. **`compact` 放在触顶时**：当估算 token 超过阈值，用真实模型对 `middle` 生成摘要。
   对应真实产品的 `PreCompact` hook —— hook 只决定“何时压、保留多少、摘要指令是什么”。
4. **保一个稳定共享头**：`system` + 原始任务说明留在摘要**之前**（`keepLeading`），这样反复
   压缩时只有摘要之后重建，头部一直命中缓存（§6 实测差 4096 token/压缩）。
5. **预算一次重预热**：压缩后第一次请求会 miss，第二次相同请求才恢复 ~98%。

## 6. 缓存行为（实测，见 `runs/m3-compaction.md`）

在 ≈31k token 的会话上（10 轮大 `read_file` 输出），分别压缩到 4.8k：

| 观测点 | cached | 说明 |
|---|---|---|
| `pre#2`（未压缩预热） | 30848 / 30923（99.8%） | 长前缀已缓存 |
| **`compact#1`（压缩后首次）** | **0** | 缩短+改写前缀 → 整段失效 |
| `compact#2`（同一请求第 2 次） | 4736 / 4814（98.4%） | **1 次调用即恢复** |
| `follow#1/#2`（纯追加） | 4736（97.7–98.2%） | 重新稳定 |
| `clear#1 / clear#2` | 0 → 15360 / 15442（99.5%） | 同样一次重预热 |
| `clear` 后 `follow` | 15360（99.4%） | 稳态命中率最高 |

**方向性**：provider 不会因为“新请求是旧缓存的截断”而给部分命中；短缓存能续接更长的请求，
长缓存不能续接更短的请求。所以压缩那一次**必然全 miss**。

**摘要放哪决定能续用多少**。隔离探针先只烘热共享头 `[system][brief]`（4608），再发两种视图
（都是 4813 token）：

| 放置 | 压缩后 cached | 保留共享头 |
|---|---|---|
| **spliced**（摘要拼进历史） | **4608** | **100%** |
| leading（摘要钉在固定前导位） | **512** | 11.1%（丢 4096） |

结论：**把摘要拼进历史，不要放在固定前导槽位。** 前缀缓存是纯位置的——spliced 只从摘要处
重建，leading 从 system 之后整段重建。固定位置并不会“更稳定”；它每次压缩都更贵。

## 7. 设计取舍与边界

- **回收 vs 缓存**：想真正缩短，就必须改写前缀、承受一次重预热；想保住缓存，就只能追加。
  两者不可兼得。压缩的工程目标是把“重建点”尽量后移。
- **`clearToolResults` vs `compact`**：前者回收 ~50%、只换正文、恢复后稳态 ~99%；后者回收
  ~84%、把原文压成摘要、恢复后稳态 ~98%。小超限优先 clearing，大超限才 compact。
- **摘要是有损的**：`compact` 丢掉原始 tool 输出；重要的可复现证据应在摘要里显式保留引用，
  或先把它写进文件 / memory 再压。
- **未做**：真实模型摘要器（本原语已支持 `await`，实验用确定性桩以隔离位置变量）、
  token 精确计数（用 `/4` 估计，真实数以 `usage` 为准）、自动阈值触发（属接线阶段）、
  memory 层与压缩的持久化整合。
