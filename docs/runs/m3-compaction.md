# 实验记录 — M3 压缩与上下文回收

**日期**：2026-10-03
**模型**：`xiaomi/mimo-v2.6-flash`（OpenRouter，自动前缀缓存）
**命令**：

```bash
# 主曲线（21 次调用）：
pnpm --filter @agent/server exec tsx scripts/compaction-experiment.ts \
  spliced leading clear --salt=mimo-m3-001
# 摘要位置隔离探针（4 次调用）：
pnpm --filter @agent/server exec tsx scripts/compaction-experiment.ts place --salt=mimo-m3-002
# 不花 API 的结构自检：
pnpm --filter @agent/server exec tsx scripts/compaction-experiment.ts selftest
```

> 复现方式：worktree `m3-compaction` 里从主 worktree 复制 `.env`（gitignored，未提交），
> `pnpm install` 后执行上面命令。`--salt` 写进每个 system prompt，保证一次运行用的是
> 从未缓存过的新前缀。样本来自 `--salt=mimo-m3-001`（主曲线，21 次调用）与
> `--salt=mimo-m3-002`（位置隔离，4 次调用），合计 **25 次** provider 调用，未触发 429。

**环境**：温度 0，`max_tokens=16`，相邻调用间隔 500ms，`session_id` 按场景固定以启用
OpenRouter sticky routing。工具集为真实 `builtinTools()`（5 个，`ToolRegistry` 按名稳定排序）：
`edit_file, list_dir, read_file, run_shell, write_file`。

## 0. 方法

`packages/server/scripts/compaction-experiment.ts` 直接用 `@agent/core` 的
`OpenRouterClient` 发流式请求，绕开 HTTP server，所以**唯一变化的只有 request body**。
每次调用读取真实的 `usage.prompt_tokens_details.cached_tokens`（以及 `prompt_tokens` /
`cost`）。

被测对象是机制自带的**纯函数**（`packages/core/src/mechanisms/compaction/`）：

- `compact(messages, { keepRecent, summarize })` —— 把中间一段折叠成一条摘要消息，
  保留最近 `keepRecent` 条原文；
- `clearToolResults(messages, { keepLastN })` —— 把旧的 `role:"tool"` 正文换成占位符，
  **保留 `tool_call_id` 结构与配对**，使 transcript 仍然合法。

实验构造一段“足够长”的真实形状会话（≈31k prompt tokens）：长且稳定的 system（含
`withCacheBreakpoint`）+ 一条长 project brief + **10 轮 `read_file` tool_call/tool 结果**
（每份输出 ~9k 字符）+ 3 条收尾消息。压缩折叠中间 20 条 tool 消息，保留 brief 与尾部。

两种摘要放置：

- **(i) spliced**：摘要**原地替换**被折叠的那一段 —— `[system][brief][summary][tail]`；
- **(ii) leading**：摘要**钉在固定前导槽位**（紧随 system）—— `[system][summary][brief][tail]`。

`summarize` 用**确定性桩**（同一条 `middle` 产出逐字节相同的摘要），因此两次放置测到的
差异纯粹来自位置。真实模型调用是本原语的 drop-in（它 `await` 注入的函数）。

每次场景的调用序列：`pre#1, pre#2`（预热未压缩视图）→ `compact#1, compact#2`（压缩后
第一次 / 第二次相同请求）→ `follow#1, follow#2`（在压缩视图上纯追加）→ `repack#1, repack#2`
（对增长后的视图做**第二次压缩**）。

## 1. 实测数据

### 1.1 主曲线（`--salt=mimo-m3-001`）

**(i) spliced — 摘要原地拼进历史**

| call | label | prompt | **cached** | hit% | cost($) | finish |
|---|---|---|---|---|---|---|
| 1 | pre#1 | 30923 | **0** | 0.0 | 0.003405 | stop |
| 2 | pre#2 | 30923 | **30848** | 99.8 | 0.002788 | stop |
| 3 | compact#1 | 4814 | **0** | **0.0** | 0.000534 | length |
| 4 | compact#2 | 4814 | **4736** | 98.4 | 0.000439 | stop |
| 5 | follow#1 | 4826 | **4736** | 98.1 | 0.000441 | length |
| 6 | follow#2 | 4846 | **4736** | 97.7 | 0.000443 | length |
| 7 | repack#1 | 4801 | **4608** | 96.0 | 0.000440 | length |
| 8 | repack#2 | 4801 | **4736** | 98.6 | 0.000438 | length |

**(ii) leading — 摘要钉在固定前导槽位**

| call | label | prompt | **cached** | hit% | cost($) | finish |
|---|---|---|---|---|---|---|
| 1 | pre#1 | 30922 | **0** | 0.0 | 0.003405 | stop |
| 2 | pre#2 | 30922 | **30848** | 99.8 | 0.002788 | stop |
| 3 | compact#1 | 4813 | **0** | **0.0** | 0.000533 | stop |
| 4 | compact#2 | 4813 | **4736** | 98.4 | 0.000439 | length |
| 5 | follow#1 | 4825 | **4736** | 98.2 | 0.000441 | length |
| 6 | follow#2 | 4845 | **4736** | 97.8 | 0.000443 | length |
| 7 | repack#1 | 3615 | **3328** | 92.1 | 0.000336 | length |
| 8 | repack#2 | 3615 | **3584** | 99.1 | 0.000330 | length |

### 1.2 摘要位置的隔离探针（`--salt=mimo-m3-002`）

主场景里预热的前缀长（30.9k）而压缩后短（4.8k），两次放置都 miss，分不出位置差异。
隔离探针只预热**共享头** `[system][brief]`（4.6k），再分别发两种压缩视图：

| call | label | prompt | **cached** | hit% | 说明 |
|---|---|---|---|---|---|
| 1 | warm#1 | 4659 | **0** | 0.0 | 预热共享头 |
| 2 | warm#2 | 4659 | **4608** | 98.9 | 共享头已缓存 |
| 3 | splice#1 | 4813 | **4608** | 95.7 | 保留**全部** 4608 |
| 4 | lead#1 | 4813 | **512** | 10.6 | 只剩 512，丢 4096 |

同样 4813 token 的请求，**spliced 保住 4608、leading 只保住 512**：差值 **4096 token
（共享头的 88.9%）**。

### 1.3 `clearToolResults`（`--salt=mimo-m3-001`）

`keepLastN=4`：base 有 10 条 tool 消息，清掉最早 6 条正文、保留最后 4 条。

| call | label | prompt | **cached** | hit% | cost($) |
|---|---|---|---|---|---|
| 1 | pre#1 | 30922 | **0** | 0.0 | 0.003405 |
| 2 | pre#2 | 30922 | **30848** | 99.8 | 0.002788 |
| 3 | clear#1 | 15442 | **0** | **0.0** | 0.001703 |
| 4 | clear#2 | 15442 | **15360** | 99.5 | 0.001396 |
| 5 | follow#1 | 15454 | **15360** | 99.4 | 0.001397 |

本地统计：`cleared=6, kept=4, charsSaved=53772, estTokSaved=13440`，且
`validateToolTranscript()` 为 **valid**（每个 assistant `tool_calls[].id` 仍有配对的
`role:"tool"` 信封）。

### 1.4 token 账（provider 真实 `prompt_tokens`）

| 原语 | before | after | Δ | cached@call1 |
|---|---|---|---|---|
| `compact`（spliced） | 30923 | 4814 | **−26109（−84.4%）** | **0** |
| `clearToolResults(keepLastN=4)` | 30922 | 15442 | **−15480（−50.1%）** | **0** |

## 2. 结论

### Q3 — 压缩后缓存恢复曲线；固定位置摘要 vs 拼进历史 —— **answered**

**恢复曲线（两种放置一致）**：压缩后**第一次**调用 `cached=0`；**第二次**相同调用即回到
**4736（98.4%）**；此后纯追加的 `follow` 稳定在 ~97.7–98.2%。即**压缩的缓存代价是“一次
全量重预热”**（1 次调用），之后重新稳定。

**为什么第一次必然 miss（关键）**：`pre#2` 预热的是 **30.9k 的完整前缀**，压缩后请求只有
**4.8k**。虽然 `[system][brief]`（≈4.6k）是新请求的前缀、也是旧请求的前缀，但 provider
返回 **0** —— 它**不会因为新请求是旧缓存的“前缀截断”而给部分命中**。对比：M2 的“尾部
追加 / 扩展前缀”保持命中；这里的“缩短 / 原地改写”整段失效。**缓存命中是方向性的：
缓存短的能命中更长的请求，缓存长的不能命中更短的请求。**

**位置差异只在“共享头曾被单独缓存”时才兑现**：隔离探针把共享头 `[system][brief]`
先烘热，于是

| 放置 | 压缩后 cached | 相对共享头 |
|---|---|---|
| spliced（摘要拼进历史） | **4608 / 4659** | 保留 100% |
| leading（摘要钉在固定前导位） | **512 / 4659** | 保留 11.1%，**丢 4096** |

原因正是前缀缓存“纯位置”：spliced 把摘要放在**已缓存的 brief 之后**，前面的字节一字未动；
leading 把摘要插在 **system 之后、brief 之前**，brief 及其后全部前移 → 从索引 1 起重建。
在**第二次压缩**（`repack#1`）上差值同向：spliced `4608/4801=96.0%`，leading
`3328/3615=92.1%`；leading 甚至因为“固定前导槽位”把上一轮摘要当成保留头，改变了被折叠的
内容，所以它数值更低（见 §3 的取舍说明）。

**回答“固定位置摘要能否重新建立稳定前缀”**：能，但**代价更高且会重复支付**。两种放置都在
第 2 次调用重建稳定前缀；区别是 leading 每次压缩都从 system 之后整段重写，而 spliced 只从
摘要处重写、保住更长的共享头。**在本 provider 上，把摘要拼进历史（spliced）明确优于固定
前导槽位（leading）。**

### §4 PreCompact / 缓存复用取舍 —— **且看数据**

Claude Code 的 `compactConversation()` 有 `PreCompact` hook，并用 feature flag 决定压缩路径
**是否复用主会话的 prompt cache**；报告里“false（不复用）”路径是 **98% cache miss**。我们的
数据解释了这个取舍：

1. **压缩本身与缓存天然冲突**：压缩=缩短+改写历史前缀，而 provider 对“缩短的旧前缀”不给
   部分命中（§2 关键点）→ 压缩调用在本实验里是 **100% miss（cached=0）**。所以“复用主会话
   缓存”在**截断场景下救不了这一次**——除非压缩方式改成**只追加**（不删中间段），而那就不
   是回收了。
2. **能救的是“提出去的摘要放哪”**：一旦你保留了某个短共享头并让它保持缓存，spliced 能把
   这 4.6k 全部续用，leading 只剩 512。
3. **必须预算一次重预热**：无论怎么放，压缩后第 1 次请求 miss、第 2 次恢复 ~98%。真实产品里
   “压缩后 attachment builders 重新宣告运行时状态”的行为是**追加**，与前缀缓存兼容；真正
   昂贵的是压缩那一次的前缀重写，而不是重宣告。

### 与 `clearToolResults` 的对比

| | compact | clearToolResults |
|---|---|---|
| 省 token | **−84.4%** | −50.1% |
| transcript 合法性 | 合法（整对删除） | 合法（保留信封） |
| 保留证据 | 丢掉原始 tool 输出 | 保留“调用发生过”+ 最近 N 条原文 |
| 压缩调用 cached | **0** | **0** |
| 恢复 | call#2 回升 98.4% | call#2 回升 99.5% |
| 恢复后稳态 | ~98%（长尾由摘要/尾部组成） | **~99.4%**（几乎全是稳定前缀） |

`clearToolResults` 回收一半上下文、代价只有一次重预热，且恢复后命中率更高（因为留下的
大多是可缓存的稳定前缀）；`compact` 回收得更彻底，但把原始 tool 证据压成一段摘要、重
预热后的稳态略低。两者可以组合：先 clearing 再 compact，或对小超限用 clearing、对大超限
用 compact。

## 3. 政策含义（可回填进 `docs/mechanisms/compaction.md`）

1. **压缩触发一次“重预热”是固定成本**：预算里要预留“压缩后第 2 次相同请求”，不要以为
   压缩能顺带省下这一次。
2. **摘要拼进历史（spliced），不要钉在固定前导槽位**：前者保住已缓存的共享头，后者每次
   压缩都从 system 之后整段重写。实测差 **4096 token/压缩**。
3. **保留一个稳定的共享头**（system + 原始任务 brief）：把摘要放在它**之后**，这样反复
   压缩时只有摘要之后重建，头部一直命中。
4. **优先 `clearToolResults`**：给定“回收 vs 缓存”两个目标，它在单位缓存代价下回收一半，
   且恢复后稳态最高（~99%）。
5. 原语**不碰 agent loop**：调用者在步骤之间把数组传进、拿新数组回去；压缩策略（何时、
   保留多少、摘要来自哪个模型）属于调用方。

## 4. 约束遵守

- 只新增文件；未改 `packages/core/src/**` 里任何已有文件、`packages/server/src/**`、
  `apps/web/**`、任何 `package.json`/lockfile、`docs/CONTRACT.md`/`MECHANISMS.md`/`ROADMAP.md`。
- 未改 agent loop 与 `events.ts`；未新增依赖（无摘要库、无 tokenizer，用 `/4` 估计）。
- `.env` 仅工作区本地复制，gitignored，未提交。
- 本里程碑 **25 次** provider 调用（21 主曲线 + 4 位置隔离），未触发 429。
- `pnpm typecheck` 全包 green。

## 复现

```bash
cp D:/Project/agent-things/.env ./.env      # gitignored
pnpm install
pnpm --filter @agent/server exec tsx scripts/compaction-experiment.ts \
  spliced leading clear --salt=mimo-m3-001
pnpm --filter @agent/server exec tsx scripts/compaction-experiment.ts place --salt=mimo-m3-002
pnpm --filter @agent/server exec tsx scripts/compaction-experiment.ts selftest
pnpm typecheck
```
