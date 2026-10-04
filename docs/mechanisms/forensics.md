# 机制：缓存取证（cache forensics —— 谁破坏了前缀缓存）

> 对应 L1「把第一个分歧块变可见」。实现：`packages/core/src/context-diff.ts`
> （纯函数）与 `apps/web/src/components/ForensicsTab.tsx`（视图）。
> 实测数据与六用例校验见 [`../runs/l1-cache-forensics.md`](../runs/l1-cache-forensics.md)。
> 前置证据：[`../runs/m1-cache.md`](../runs/m1-cache.md)、
> [`../runs/m4-mcp.md`](../runs/m4-mcp.md)、
> [`./compaction.md`](./compaction.md)、[`./skills.md`](./skills.md)。

## 1. 一句话

前缀缓存是**序列化请求的字节前缀**；命中恰好止于**第一个发生分歧的块**。
`diffRequests(prev, next)` 把这个块指出来——`system` / `tools` / `messages`——
于是"这一轮为什么没命中"从一个需要脑内 diff 的推理，变成一个可读的结论。

## 2. 前缀模型

Provider 把请求体按固定顺序序列化：

```
[ system 消息 ]  ->  [ tools 数组（顺序敏感） ]  ->  [ messages 数组 ]
        ↑ 稳定前缀的第一个块          ↑ 第二个块                ↑ 尾部
```

缓存是一种**方向性的字节前缀匹配**：

1. **从第一个被改动的字节起，之后全部失效。** 只动前缀尾部 → 前缀仍命中；动前缀内部
   → 从动点起重建。
2. **先序列化的块不能被后序列化的块"救"。** `system` 排在 `tools` 之前，`tools` 排在
   `messages` 之前。所以**第一个不同的块**就决定了损失范围：system 变了，后面 tools/messages
   再稳定也没用；tools 变了，messages 再稳定也白搭。
3. **消息数组只追加是免费的。** 在尾部追加新 turn 不碰已缓存前缀的字节，命中绝对 token 数
   不变（M1 §1.5：grow 全程 cached=3328）；前缀内改写则整段失效。

已被 M1/M2/M3/M4 反复印证的量化结论：

| 动作 | 首个分歧块 | 已记录真实观测 |
|---|---|---|
| 相同请求重发 | `none` | cached 稳定 3328/3371（m1 §1.1） |
| 反转 `tools` 顺序 | `tools` | cached 3328 → **0**（m1 §1.2、m4 §3b） |
| 追加 1 个工具 | `tools` | cached 3328 → **0/512**，新增仅 ~169 token（m1 §1.3、m4 §3a） |
| `system` 改 1 byte | `system` | cached 3328 → **512**（m1 §1.4） |
| 尾部追加整 turn | `none` | cached 绝对值不变，hit% 只随分母缓降（m1 §1.5） |
| 前缀内改写（skill 正文插进 system） | `system` | cached 3456 → **0**（m2 §(c)） |
| 压缩：缩短 + 改写 | `system`/`messages` | 压缩那一次必 miss，第 2 次恢复 ~98%（m3 §1/§2） |

**一句话记住**：缓存只认"把新东西放到最后"；任何"回头改前面"都要付一次重预热。

## 3. 分类器 API（`packages/core/src/context-diff.ts`）

```ts
import { diffRequests } from "@agent/core";

const d = diffRequests(prevBody, nextBody);
// d = {
//   divergence: "none" | "system" | "tools" | "messages",
//   firstDivergentBlock: 同 divergence,
//   system:   { same, changedAt?, prevLen, nextLen },
//   tools:    { same, added: string[], removed: string[], reordered, firstDiffIndex? },
//   messages: { prefixLen, appended, changedAt? },
// }
```

判定顺序（先命中者胜）：

1. `system` 摊平文本逐字节不同 → `"system"`；
2. 否则 `tools` 任一 schema 不同 → `"tools"`（成员变记 `added`/`removed`，成员同但位次变记
   `reordered`）；
3. 否则消息数组在某个 **turn slot** 上改写 → `"messages"`；
4. 否则（唯一变化是尾部追加）→ `"none"`，且 `messages.appended > 0`。

### 3.1 为什么以"turn slot"为比较单位

`assistant{ tool_calls:[id] }` 与其后的 `tool{ id }` 是一个不可分割的 turn。把它们绑成一个
slot 后：

- "整轮追加"被正确判成纯追加（`none`）——和 M1 §1.5 / M2 (b) 的真实曲线一致；
- 前缀内的**等长改写**（如 `tool_call_id` 从 `call_0` 变 `call_1`）被判成 `messages` 分歧——
  因为它在序列化前缀里真的重写了字节。

这正是 M2 §2 修正后的准确表述：**破坏缓存的不是"改 system"这个动作，而是"在前缀内部做
非追加式修改"。** 位置，而非消息角色，才是判据。

### 3.2 字段的单位（避免误读）

- `system.changedAt`：**字节**索引（摊平 system 文本的第一个不同字符位置）。
- `messages.changedAt`：**turn-slot** 序号（0-based），等于首个分歧前的共享 slot 数；
  `messages.prefixLen` 是保住的共享 slot 数。
- `messages.appended`：纯追加时尾部多出的 slot 数；有改写时为 0。

`changedAt`/`prefixLen` 是计数而非序列化字节偏移——归因"哪个块坏了"足够，若要定位"坏了几个
字节"仍需序列化级 diff（见 run 文档 §1 边界）。

## 4. 怎么读 Forensics 视图

Web 的 **Forensics** 标签页（`Observatory` 里，会话出现第 2 个 `request.sent` 后才显示）
把每对相邻请求渲染成一张卡片：

```
req #3 → #4                    10:31:07 → 10:31:09        [ tools ]   <- 分歧块高亮
[ system ]  →  [ ◆ tools ]  →  [ messages ]
  system    same · 3371 chars
  tools     reordered
  messages  append-only · +1 turn(s), prefix intact
  cached before 3328  →  cached after 0   / 3372 prompt
```

读法（从上到下，就是缓存失效的顺序）：

1. **看琥珀色的分歧块**：它就是"谁破坏了缓存"的答案。`none (append-only)` 是绿色，
   表示这一轮健康、只花了尾部新增的 token。
2. **看 `tools` 的变化**：`reordered` / `+name` / `−name` 三个来源，对应 M4 的"重排=全 miss、
   加成员=丢几千 token"。
3. **看 `messages`**：`append-only · +N turn(s)` 是免费的；`edited at turn K · prefix L kept`
   说明第 K 个 turn 被改写、前 L 个 turn 还活着。
4. **看 `cached before → after`**：这是分类器的**真实校验**。分类器说 `tools`/`system`/`messages`
   时，after 通常骤降（0 或几百）；分类器说 `none` 且是追加时，after 的绝对值应与 before 持平。

**视图与 run 文档一致**：给一个工具被重排的真实会话打开它，卡片高亮 `tools` 并显示
`reordered`，与 m1 §1.2 / m4 §3b 的文字描述指同一个块。

## 5. 工程用法：把"缓存事故"变成一次审查

1. **回归护栏**：任何"注入上下文"的新机制上线前，先构造它的前后请求对、跑 `diffRequests`，
   确认 `divergence` 落在预期块。声称"尾部注入"的机制若返回 `system` 或 `messages`，
   说明它偷偷改写了前缀。
2. **确定性排序的证据**：工具注册表按 name 排序（`ToolRegistry.list()`）的理由，在这个视图里
   是可见的——顺序抖动会直接变成一次 `tools` 分歧。
3. **压缩/清空的预算**：压缩必然产生一次 `messages`（或 `system`）分歧 → 预算里预留"下一次
   相同请求"来重预热（m3 §2/§3）。
4. **观测与内核解耦**：分类器是纯函数、零依赖，core 与 web 各持一份同构实现；web 那份只吃
   `request.sent` 事件体，永远不参与模型上下文。

## 6. 边界与未做

- **不精确到字节（消息块）**：`messages.changedAt` 是 slot 序号，不是字节偏移；定位"坏了几个
  字节"需要序列化级 diff。
- **只看缓存相关的请求字段**：`temperature`/`max_tokens` 等不参与判定（它们不在前缀哈希里）。
- **不预测实际 cached 值**：provider 的缓存是按 token 块（本模型约 512 token 粒度）对齐的，
  分类器只回答"哪个块变了"，不预测掉多少 token——真实数字仍以 `usage.cached_tokens` 为准。
- **两份实现需同构**：web 不能 import core，故 `apps/web/src/forensics.ts` 复刻了同一逻辑；
  改动其一时必须同步另一份（run 文档 §2 记录了这条不变式）。

## 参考

- [`../runs/l1-cache-forensics.md`](../runs/l1-cache-forensics.md) — 六用例零 API 校验表。
- [`../runs/m1-cache.md`](../runs/m1-cache.md) §1.2–§1.5 — 工具顺序/成员、system、追加的真实曲线。
- [`../runs/m4-mcp.md`](../runs/m4-mcp.md) §3 — MCP 工具成员/顺序变化的前缀失效。
- [`./compaction.md`](./compaction.md) §6 — 压缩的"一次重预热"与摘要位置。
- [`./skills.md`](./skills.md) — 尾部注入 vs 前缀内改写。
