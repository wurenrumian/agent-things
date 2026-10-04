# 机制：记忆（memory）

> 对应 MECHANISMS 的 L3「memory」与 §5 的钩子问题「改记忆是否炸缓存 / memory 注入位置」。
> 实现位于 `packages/core/src/mechanisms/memory/`，实验数据见
> [`../runs/m9-memory.md`](../runs/m9-memory.md)。

## 1. 一句话

记忆 = **一份持久化的事实清单** + **在正确时机把它变成上下文里的字符**。它不是一个数据库
特性，而是“把正确的字符，在正确的时机，放进消息数组”的又一种形态；**放在哪**决定了它是
不是会炸掉 provider 的前缀缓存。

## 2. 为什么需要它

Agent 的上下文是有限的、易失的：一次会话结束，模型就什么都不记得。让知识跨会话存活，有
两种极端做法：

- **全部常驻**：把记忆塞进 system prompt。上下文随记忆增长而膨胀，而且**记忆一变就毁了
  已缓存的前缀**（M1：system 改 1 byte 丢 84.6%）。
- **完全按需**：模型根本不知道自己“记得”什么，也就无法主动取用。

正确做法是把它拆成两个半边：**持久的清单**（不进上下文）和**按需的注入**（进入上下文，
且落在尾部）。这就是本机制的教具。

## 3. 两个半边

```
写：模型 / 协调者 ──> MemoryStore ──> memories.ndjson（append-only，模型看不见）
读：查询 ──> recall / memory search ──> renderMemories ──> 尾部 tool result（模型看得见）
```

- **持久半边**：`MemoryStore`，只负责“记住什么”，对模型不可见。
- **注入半边**：`renderMemories` 把条目渲染成一段稳定文本；注入点由调用方选（尾部 tool
  result 或 system 后缀）。

## 4. 持久化：append-only NDJSON

一个条目：

```ts
interface MemoryEntry {
  id: string;          // mem_<time36>_<counter36>_<rand>
  text: string;        // 一条自包含的事实
  tags?: string[];     // 可选标签，检索时也参与匹配
  createdAt: number;   // epoch ms
  updatedAt?: number;  // 未更新时缺省
}
```

落盘是一个换行分隔的 JSON 文件（默认 `memories.ndjson`），**只追加、从不原地改写**：

```jsonc
{"op":"save","entry":{"id":"mem_...","text":"...","createdAt":...,"tags":["m9"]}}
{"op":"forget","id":"mem_...","at":...}      // 删除 = 追加一条墓碑
```

`MemoryStore.open(dir)` 回放整个日志重建内存索引；缺失/空文件不算错误；末尾半行（崩溃
残留）解析失败即跳过。全是 `node:fs`，**无依赖**。

```ts
const store = await MemoryStore.open(dataDir + "/memory");
const a = await store.save("The build uses pnpm.", ["build"]);
store.all();                       // MemoryEntry[]，按插入序，最旧在前
store.get(a.id);                   // 单条
store.search("build", 5);          // 确定性 top-K
await store.forget(a.id);          // 写墓碑，返回是否命中
store.dir(); store.file(); store.size();
```

## 5. 检索：确定性排序（无 embedding）

`search` / `recall` 用同一套**纯函数**排序，可复现、可离线预取：

```
score = 1000 * overlap + recencyIndex
overlap      = 命中查询关键词的数量（正文或标签；标签精确命中额外 +1）
recencyIndex = 条目在插入序里的下标（越新越大）
```

关键词先 `tokenize`（小写、Unicode 分词、去停用词、单字符），重叠项乘 1000，所以**相关度
永远压过新近度**，新近度只是平局打破；最后再按 `id` 比较，保证全序确定。查询没有关键词时，
退化为“最近优先”。`recall(query, { store, limit })` 是给协调者的预取入口——不花一次模型
调用就能拿到 top-K。

```ts
import { recall } from "../../core/src/mechanisms/memory/index.js";
const hits = recall("cache injection point", { store, limit: 3 });
```

## 6. 注入：`renderMemories` 与两个位置

渲染成一段**字节稳定**的块（插入序、无时钟、只有条目自己的 `createdAt`）：

```text
<memories>
- [mem_abc] saved=2026-10-04T05:57:30.266Z tags=m9,cache M9 cache rule: inject memories as a tail tool result, never rewrite the system prefix.
</memories>
```

同一个字符串，可以放在两个结构不同的位置：

| 辅助 | 产出 | 位置 | 缓存后果 |
|---|---|---|---|
| `memoryTailMessage(entries)` | 一条 `user` 消息 | 消息数组**尾部** | 前缀保留，只新增尾部未命中 |
| `memorySystemSuffix(entries)` | 一段文本（`\n\n<memories>…`） | **追加到 system 末尾** | 追加安全（纯位置缓存）；但**插进前缀内部**即全 miss |
| `createMemoryTool` 的输出 | 一段字符串（即 `renderMemories`） | `role:"tool"` 结果，循环追加在尾部 | 前缀保留（生产默认） |

**关键区分**：破坏缓存的不是“改 system”这个动作，而是**在前缀内部做非追加式修改**。
把记忆接到 system 最末尾等价于尾部追加，安全；把记忆插到 system 已有内容中间，会让其后
每个字节前移，从插入点起全部重建。

## 7. 工具 API：一个 `memory` ToolDef

```jsonc
{
  "name": "memory",
  "action": "save | list | search | forget",   // required
  "text":  "save 用：要记住的事实",
  "tags":  ["…"],                                // save 可选
  "query": "search 用：关键词",
  "id":    "forget 用：条目 id",
  "limit": 5                                     // search 可选
}
```

`execute()` 只做一件事：委托 `MemoryStore` 并用 `renderMemories` 格式化。它的返回字符串是
**唯一**进入模型上下文的东西，且由 agent loop 作为 `role:"tool"` 消息追加在**尾部**。

- `readOnly: false`：因为 `save`/`forget` 会改持久状态。一个 `ToolDef` 只有一个布尔位，取
  保守值；于是 `standard` 模式下连 `search` 也会被门控。接线阶段若想让读操作免审批，可
  拆成两个工具（`memory_read` / `memory_write`）。
- `list` 最多返回 50 条（取最新），`search` 默认 5 条。

## 8. 公共 API（`mechanisms/memory/index.ts`）

```ts
import {
  MemoryStore, createMemoryTool, recall, renderMemories,
  memorySystemSuffix, memoryTailMessage,
  MEMORY_TOOL_NAME, MEMORY_FILE,
} from "../../core/src/mechanisms/memory/index.js";
```

| 导出 | 说明 |
|---|---|
| `MemoryStore` | `open(dir)` / `save` / `all` / `get` / `search` / `forget` / `size` / `dir` / `file` |
| `createMemoryTool(store)` | 返回 `memory` `ToolDef` |
| `recall(query, opts)` | 无模型预取 top-K |
| `renderMemories(entries, opts)` | 稳定文本块 |
| `memorySystemSuffix` / `memoryTailMessage` | 两种注入位置 |
| `MemoryEntry` / `MemoryRecord` / `RenderOptions` / `RecallOptions` | 类型 |

## 9. 接入一个 agent（合并阶段的接线方式）

1. 启动时 `const store = await MemoryStore.open(memoryDir)`（`memoryDir` 可配置；单文件
   还在 `store.file()`）。
2. `registry.register(createMemoryTool(store))`。工具集成员一旦加入就固定住（M1：增删工具
   炸缓存）。
3. 循环里正常执行：`memory` 的检索结果作为 `role:"tool"` 追加在**尾部**。
4. 可选：若有一段**永不变化**的记忆要常驻，用 `baseSystem + memorySystemSuffix(store.all())`
   追加到 system 末尾；**绝不**插进已有内容中间。
5. 可选：在模型调用前用 `recall(query, { store })` 预取，自行决定是否注入。

核心是第 3 步——**记忆以 tool result 进尾部，绝不回头改写 system 前缀。**

## 10. 缓存行为（实测，见 runs/m9-memory.md）

同一份 437-char 记忆块（真实 `memory search` 输出），预热后连打 3 次完全相同的“带记忆”请求：

| 注入位置 | 预热 cached | inject#1 cached | inject#2/#3 | 判定 |
|---|---|---|---|---|
| system 前缀**内部**（改写） | 3648 | **0** | 3840 / 3840 | 前缀全失效，付一次全量 re-warm |
| 消息数组**尾部**（tool result） | 3584 | **3584**（不变） | 3840 / 3840 | 前缀保留，只新增尾部未命中 |

- (a) `inject#1` 贵（`$0.000541`），因为按冷调用重算整段前缀；(b) `inject#1` 只 `$0.000440`。
- (b) 的 `inject#1` 与其 `warm#2` 的 `cached` **完全相同**（3584）：system + tools + 首条
  user 全部命中，只有那段记忆是新的。

## 11. 设计取舍与边界

- **确定性优先**：手写关键词 + 新近度排序，而非 embedding——可复现、零依赖、可离线预取；
  代价是语义泛化弱（同义改写检索不到，除非共享关键词）。
- **append-only 日志**：`forget` 用墓碑，换取崩溃安全与可审计；代价是文件只增不减，需要
  外部整理（compaction）才能回收。
- **不做**：跨目录发现/父子合并、去重/更新、文件锁与多写者并发、语义检索、记忆大小上限与
  压缩。这些留待接线阶段或后续里程碑。
- **信任边界**：条目来自模型/协调者，渲染进上下文等同用户内容；接线时应与权限层配合
  （`readOnly:false` 已让写操作受门控）。
