# 实验记录 — M9 记忆（memory）

**日期**：2026-10-04
**模型**：`xiaomi/mimo-v2.6-flash`（OpenRouter，自动前缀缓存）
**命令**：

```bash
pnpm --filter @agent/server exec tsx scripts/memory-experiment.ts --salt=mimo-m9-001
# 只跑某一部分：
pnpm --filter @agent/server exec tsx scripts/memory-experiment.ts selftest        # 0 次 API
pnpm --filter @agent/server exec tsx scripts/memory-experiment.ts cross-session   # 跨会话
pnpm --filter @agent/server exec tsx scripts/memory-experiment.ts cache           # 缓存实验
```

> 复现方式：worktree `m9-memory` 里从主 worktree 复制 `.env`（gitignored，未提交），
> `pnpm install` 后执行上面的命令。`--salt` 写进每个 system prompt，保证一次运行用的是
> 从未缓存过的新前缀。样本来自 `--salt=mimo-m9-001`。本里程碑共 **14 次 API 调用**。

## 0. 方法

机制实现是自包含的 `packages/core/src/mechanisms/memory/**`：

| 文件 | 职责 |
|---|---|
| `store.ts` | `MemoryStore`：append-only 的 NDJSON 日志（`save` 追加、`forget` 写墓碑），`open(dir)` 回放重建索引 |
| `recall.ts` | 确定性排序：**关键词重叠 + 新近度**（无 embedding），`recall(query, opts)` 供协调者预取 |
| `render.ts` | `renderMemories(entries)` + `memorySystemSuffix` / `memoryTailMessage` 两个注入辅助 |
| `tool.ts` | `createMemoryTool(store)`：一个名叫 `memory` 的 `ToolDef`，动作 `save`/`list`/`search`/`forget` |

`packages/server/scripts/memory-experiment.ts` 绕过 HTTP server，直接用 `@agent/core`：

- **跨会话**用真实的 `Agent`（`sessionPromptOverride` 未设，即生产系统提示词）注册真实
  `memory` 工具，A 存、B 取；B 是**另一个** `Agent`、另一个 session id、空历史，只共享
  磁盘目录。
- **缓存实验**用 `OpenRouterClient.chatStream` 直接发请求（与 M1/M2 同一 harness），固定
  `session_id` 启用 sticky routing，`temperature=0`、`max_tokens=16`、调用间隔 500ms，
  每次读取真实的 `usage.prompt_tokens_details.cached_tokens`。工具集固定为
  `builtinTools() + memory`（6 个，`ToolRegistry` 按名稳定排序）。

## 1. 自测（0 次 API）

`selftest` 分组不调用模型，逐条验证存储与检索面：

```
PASS  insertion order preserved
PASS  keyword search ranks the cache entry first
PASS  recall top-1 matches the memory entry
PASS  search with no keywords returns newest first
PASS  forget removes the entry
PASS  reopen replays the append-only log
PASS  render is byte-stable
self-test: 7/7 passed
```

其中 “reopen replays the append-only log” 证明 `forget` 写的是墓碑而非改写文件：重新
`open()` 后 2 条存活、被忘的 id 不在。

## 2. 跨会话持久化（真实 Agent）

**Session A**（新 `Agent`，只注册 `memory` 工具）把三条事实经 `memory` 工具存下：

```
session A: sessionId=m9-sessionA-mimo-m9-001 calls=2 tool_calls=3 saved=3
log file (...\session\memories.ndjson), 3 record(s):
  {"op":"save","entry":{"id":"mem_mutesn4q_1_zt92v4","text":"The M9 project codename is Blue Lantern.",...}}
  {"op":"save","entry":{"id":"mem_mutesn4s_2_mym5iu","text":"M9 memory persists as newline-delimited JSON in memories.ndjson.",...}}
  {"op":"save","entry":{"id":"mem_mutesn4u_3_3bjsen","text":"M9 cache rule: inject memories as a tail tool result, never rewrite the system prefix.",...}}
```

A 存进磁盘的条目（`renderMemories`）：

```text
<memories>
- [mem_mutesn4q_1_zt92v4] saved=2026-10-04T05:57:30.266Z tags=m9,codename The M9 project codename is Blue Lantern.
- [mem_mutesn4s_2_mym5iu] saved=2026-10-04T05:57:30.268Z tags=m9,persistence M9 memory persists as newline-delimited JSON in memories.ndjson.
- [mem_mutesn4u_3_3bjsen] saved=2026-10-04T05:57:30.270Z tags=m9,cache M9 cache rule: inject memories as a tail tool result, never rewrite the system prefix.
</memories>
```

**Session B** 打开一个**全新的 store 句柄**（从磁盘回放 3 条），是一个不同的 `Agent`、不同
session id、空历史，向模型问“codename 是什么”。它调用 `memory search`，取回：

```text
<memories>
- [mem_mutesn4q_1_zt92v4] ... The M9 project codename is Blue Lantern.
- [mem_mutesn4u_3_3bjsen] ... M9 cache rule: inject memories as a tail tool result, ...
- [mem_mutesn4s_2_mym5iu] ... M9 memory persists as newline-delimited JSON ...
</memories>
B final answer: "Blue Lantern"
cross-session recall of "Blue Lantern": PASS
calls: A=2 (prompt=1704, cached=0, $0.000264)  B=2 (prompt=1372, cached=0, $0.000202)
```

“Blue Lantern” 只存在于 A 写入的磁盘文件里，B 的系统提示词、历史、工具 schema 都不含它。
B 能答出来，只能来自 `memory` 工具把它作为 **tool result** 注入上下文。这就是“记忆跨越
会话”的可观测证明。B 的 prompt（1372）反而比 A（1704）小，因为 B 是全新会话、没有 A 的
三条工具结果。

## 3. 缓存实验 — 注入位置

同一份渲染好的记忆块（**真实 `memory` 工具的 `search` 输出**，437 chars，3 条）用两种方式
注入，每种在预热后连打 **3 次完全相同**的“带记忆”请求：

- **(a) prefix rewrite**：把块插进 **system prompt 靠前**位置（后续所有字节前移）；
- **(b) tail injection**：块作为 `role: "tool"` 结果追加在消息数组**尾部**（在一条合成
  assistant tool_call 之后，即 agent loop 实际会追加的位置）。

工具集、温度、session 全程相同；两种方式给的**字节完全相同**，唯一差别是位置。
`system chars: base=14169  rewritten=14646  block=437`。

### 3.1 完整 ledger

| style | call | label | prompt | cached | hit% | cache_write | cost($) |
|---|---|---|---|---|---|---|---|
| (a) prefix | 1 | warm#1 | 3652 | 0 | 0.0 | 0 | 0.000513 |
| (a) prefix | 2 | warm#2 | 3652 | **3648** | 99.9 | 0 | 0.000012 |
| (a) prefix | 3 | inject#1 | 3855 | **0** | **0.0** | 0 | 0.000541 |
| (a) prefix | 4 | inject#2 | 3855 | 3840 | 99.6 | 0 | 0.000014 |
| (a) prefix | 5 | inject#3 | 3855 | 3840 | 99.6 | 0 | 0.000014 |
| (b) tail | 1 | warm#1 | 3697 | 0 | 0.0 | 0 | 0.000445 |
| (b) tail | 2 | warm#2 | 3697 | **3584** | 96.9 | 0 | 0.000409 |
| (b) tail | 3 | inject#1 | 3925 | **3584** | 91.3 | 0 | 0.000440 |
| (b) tail | 4 | inject#2 | 3925 | 3840 | 97.8 | 0 | 0.000437 |
| (b) tail | 5 | inject#3 | 3925 | 3840 | 97.8 | 0 | 0.000437 |

### 3.2 逐条结论

**(a) 改写 system 前缀 → 全掉。** 把记忆块插进前缀内部，`inject#1` 的 `cached` 从预热态的
3648 直接塌到 **0**：从被改动的字节起，整个前缀重建。代价是那次调用按冷调用计费
（`$0.000541`，而 (b) 的 inject#1 只有 `$0.000440`）。下一次相同请求（`inject#2/3`）才
回升到 3840/3855 = **99.6%**——即“改记忆”需要**再预热一次**才能重建缓存。

**(b) 尾部注入 → 前缀纹丝不动。** `inject#1` 的 `cached=3584`，**与它自己的 `warm#2`
（3584）逐字节相同**：system + tools + 首条 user 全部命中，只有尾部新增的 437-char 记忆块
未命中。hit% 从 96.9 降到 91.3 纯粹是分母变大（+228 token），不是前缀失效。`inject#2/3`
把含记忆的整段也纳入缓存，达到 3840/3925 = **97.8%**。

> 说明：两次预热 `warm#2` 命中 3648 vs 3584（差一个 64-token 缓存块，provider 分块/路由
> 噪声，M1 §1.2 已记录过类似粒度）。决定性对比是 `inject#1`：**0 vs 3584** —— (b) 精确保住
> 了它的预热前缀，(a) 一个字节都没保住。

## 4. 回答 MECHANISMS §5「改记忆是否炸缓存 / memory 注入位置」

**改记忆不一定炸缓存。** 炸缓存与否只取决于**注入位置**，与“记忆”本身无关：

| 注入位置 | 相对预热 cached | 判定 |
|---|---|---|
| system 前缀**内部**（改写） | 3648 → **0** | 前缀全失效，付一次全量 re-warm |
| 消息数组**尾部**（tool result / 尾部消息） | 3584 → **3584**（不变） | 前缀保留，只新增尾部未命中 |

政策（与 M1/M2 一致，可回填机制文档）：

1. **记忆是持久状态，不是常驻前缀。** 检索结果一律作为 `memory` 工具的 **tool result**
   落在尾部；绝不为了“把记忆放进上下文”而改写 system。
2. 如果确实需要一段**固定不变**的记忆块常驻 system，只允许**追加到 system 末尾**
   （M2 §c′：纯位置缓存，追加安全）；插到已有内容中间就会全 miss。
3. 记忆内容变化 → 只影响尾部；下一次相同调用即把新尾部纳入缓存，无需重建整段前缀。

§6 其余条目（发现顺序、父子目录合并）不在本里程碑：本实现把目录与叠加顺序显式交给调用方
（`MemoryStore.open(dir)` + 插入序），留待 INT-* 接线。

## 5. 约束遵守

- 只新增了四个目标路径下的文件；未改 `packages/core/src/**`、`packages/server/src/**`、
  `apps/web/**`、任何 `package.json`/lockfile；未改 `docs/CONTRACT.md`/`MECHANISMS.md`/
  `ROADMAP.md`。
- **未新增依赖**：持久化用 `node:fs`，排序/渲染全部手写。
- `.env` 仅工作区本地复制，gitignored，未提交。
- 本里程碑共 **14 次 API 调用**（≤ ~30）。
- `pnpm typecheck` 全包 green。

## 复现

```bash
cp D:/Project/agent-things/.env ./.env      # gitignored
pnpm install
pnpm --filter @agent/server exec tsx scripts/memory-experiment.ts --salt=mimo-m9-001
pnpm typecheck
```
