# 实验记录 — L1 缓存取证（cache forensics，"谁破坏了缓存"）

**日期**：2026-10-04
**模型**：`xiaomi/mimo-v2.6-flash`（分类器本身与模型无关；模型仅在 §0 的取证对照里出现）
**命令**：

```bash
# 零 API 校验（本报告的核心证据）：
pnpm --filter @agent/server exec tsx scripts/forensics-experiment.ts
# 代码验收：
pnpm typecheck
pnpm --filter @agent/web build
```

> 本工作区为 `learn` 波次的 L1，基于 `master`。分类器 `diffRequests()` 是**纯函数**，整个
> 实验**不需要 `.env`、不联网、不花 API**。文中所有"provider 行为"的对照数据都来自已记录的
> [`m1-cache.md`](./m1-cache.md) 与 [`m4-mcp.md`](./m4-mcp.md)，本里程碑不重复调用。

## 0. 学习目标与方法

前缀缓存的本质是**序列化请求的字节前缀**：布局固定为 `system → tools → messages`，
命中恰好止于**第一个发生分歧的块**。在此之前，学习者想知道"这一轮为什么没命中"，必须同时
打开 M1/M2/M3/M4 四篇 run 文档、在脑子里 diff 两个 request body。L1 把这个因果步骤**做成工具**：

- 给两个**连续**的请求体，指出**第一个分歧块**并归因（`system` / `tools` / `messages`）；
- 给出工具集的变化（新增 / 删除 / 重排）；
- 给出消息数组是**纯追加**还是**中间改写**；
- 在 Web 上把这一切和真实的 `usage.cached_tokens` 前后值并排显示。

方法：`packages/core/src/context-diff.ts` 暴露一个确定性、无依赖的纯函数
`diffRequests(prev, next)`。校验由 `packages/server/scripts/forensics-experiment.ts` 完成——
**零 API**，只构造请求对并断言分类结果。

### 与已记录实验的语义对齐

| L1 分类 | 依据的已记录现象 | 出处 |
|---|---|---|
| 相同 → `none` | 相同请求第 2 次起稳定命中（cached 3328/3371） | m1 §1.1 |
| 工具反转 → `tools`（`reordered`） | 反转 5 个工具顺序，cached 3328→**0** | m1 §1.2、m4 §3b |
| 加一个工具 → `tools`（`added`） | 追加 1 个工具，cached 3328→**0/512** | m1 §1.3、m4 §3a |
| system 改 1 字节 → `system` | sentinel 改 1 byte，cached 3328→**512** | m1 §1.4 |
| 尾部追加 → `none`（`messages.appended>0`） | 每轮追加整 turn，cached 绝对值**不变**（3328） | m1 §1.5、m2 §(a)/(b) |
| 中间消息改写 → `messages` | 前缀内改写即失效；纯位置失效 | m2 §(c)、m3 §1.2 |

## 1. 分类语义（`diffRequests`）

按**序列化顺序**逐块判定，先命中的块胜出：

```
system  同一块:  把消息数组里所有 role:"system" 的 content 摊平成文本, 逐字节比
tools   同一块:  逐个比较 tool schema（键序无关的稳定 JSON）; 成员变化记 added/removed,
                 成员相同但位置不同记 reordered
messages同一块:  把消息数组切成"turn slot"（assistant + 其后的 tool 消息算一个 slot）,
                 逐 slot 比较; 全是 prev 的 slot 且只在尾部多出 slot -> 纯追加
```

判定规则：

- `system` 不同 → `divergence: "system"`（后续块不参与归因）；
- 否则 `tools` 不同 → `"tools"`；
- 否则消息在某个 slot 上改写 → `"messages"`；
- 否则（唯一的变化是尾部追加）→ `"none"`，`messages.appended > 0`。

### 一个精确化：比较单位是"turn slot"，不是"原始消息"

`assistant{ tool_calls:[id] } + tool{ id }` 是一个**不可分割的 turn**。这样切分后，
"与 m1 §1.5 / m2 (b) 同形的 append-only"会被判成纯追加（`none`），而任何**前缀内改写**
（哪怕是 `tool_call_id` 从 `call_0` 变 `call_1` 这类等长编辑）都会被判成 `messages` 分歧——
因为前者在缓存前缀里字面上重写了字节，后者没有。这正是 m2 §2 修正后的结论：
**破坏缓存的不是"改 system"这个动作，而是"在前缀内部做非追加式修改"。**

### 已知边界（诚实标注）

1. count 级比较不追踪字节偏移：`messages.changedAt` 是消息数组里的 **turn-slot 序号**
   （0-based，等于首个分歧前的共享 slot 数），不是序列化字节偏移。归因"块"足够用；
   若要精确到"被改的字节位置"仍需序列化级 diff。
2. `system` 的 `changedAt` 才是**字节**索引（摊平后的文本前缀长度）。
3. 只比较请求体里与缓存相关的内容；`temperature`/`max_tokens` 等字段不参与（它们不在
   前缀哈希里，本工具只回答"哪个**块**变了"）。

## 2. 零 API 校验（核心证据）

`forensics-experiment.ts` 用真实 `builtinTools()`（5 个）+ 真实 `withCacheBreakpoint()` 构造
请求对，断言六种情形。实测输出（原样粘贴）：

```
forensics-experiment — diffRequests classifier (zero API calls)
model=xiaomi/mimo-v2.6-flash  builtin tools=5

#  case                                    expected    actual  verdict  detail
-  --------------------------------------  --------  --------  -------  ----------------------------------------------
1  identical bodies                            none      none     PASS  none · no change anywhere
2  tools reversed                             tools     tools     PASS  tools · reordered: true
3  one tool added (fetch_url)                 tools     tools     PASS  tools · added: ["fetch_url"]
4  system changed 1 byte                     system    system     PASS  system · changedAt set
5  append-only messages                        none      none     PASS  none · messages.appended > 0
6  tools identical, middle message edited  messages  messages     PASS  messages · changedAt > 0, prefix survives

ALL PASS — 6/6 cases
```

每个用例的断言（不止看 `divergence`，还看细分字段）：

| # | 用例 | `expected` | 额外断言 | 判定 |
|---|---|---|---|---|
| 1 | 请求体完全相同 | `none` | `system.same && tools.same && changedAt===undefined && appended===0` | PASS |
| 2 | `tools` 顺序反转 | `tools` | `reordered===true && added===[] && removed===[]` | PASS |
| 3 | 追加一个 `fetch_url` | `tools` | `added===["fetch_url"] && reordered===false` | PASS |
| 4 | `system` sentinel 改 1 byte | `system` | `system.same===false && changedAt 为数字` | PASS |
| 5 | 只追加一个完整 turn | `none` | `appended>0 && changedAt===undefined && system/tools 均 same` | PASS |
| 6 | tools 不变，中间 tool 正文改写 | `messages` | `changedAt>0 && prefixLen>0 && appended===0` | PASS |

**6/6 全 PASS，零 API 调用。** 这与 §0 表格里 M1/M4 的真实 `cached_tokens` 曲线方向完全一致：
分类器说 `tools`，M1/M4 就观察到 cached 从 3328 掉到 0/512；分类器说 `none`（追加），
M1 §1.5 就观察到 cached 绝对值不变。

### Web 侧的同构实现

Web 不能 import `@agent/core`（只走 HTTP，见 `apps/web/src/types.ts` 注释），因此
`apps/web/src/forensics.ts` 复刻了同一套 `diffRequests`。两处必须**形状一致**：core 版本由
上面的实验证明；web 版本与 core 逐行同构，且 web 视图只消费那些已被实验固定下来的字段。

## 3. Web：Forensics 视图

新增一个 **Forensics** 标签页（`apps/web/src/components/ForensicsTab.tsx`），仅在会话里有
**≥2 个 `request.sent`** 时出现（与 Diff tab 的"出现条件"策略一致，空会话保持原样）。
对每一对相邻请求，渲染：

- **首个分歧块的高亮条**：`system → tools → messages` 三个 chip，发生分歧的那个高亮为琥珀色
  （`◆` 标记），与 `divergence` 对应；
- **变化分类**：`system` 是否同、`tools` 的 `reordered`/`+added`/`−removed`、
  `messages` 是"append-only · +N turns"还是"edited at turn K · prefix L kept"；
- **缓存前后值**：把该请求下一次 `usage` 事件的 `prompt_tokens_details.cached_tokens`
  作为"after"，上一请求的作为"before"并排显示（命中非零时染绿）。

因此，用真实会话打开这个视图时，**它指向的分歧块与 run 文档描述的完全一致**：例如
`m1 §1.2` 那类"工具重排"会显示 `tools` 高亮 + `reordered`，并且 `cached before > after`。

## 4. 验收对照

| 验收项 | 结果 |
|---|---|
| `pnpm typecheck`（4 包） | **green**（core / server / cli / web） |
| `pnpm --filter @agent/web build` | **green**（tsc -b + vite build，44 modules） |
| `forensics-experiment.ts` 六用例 | **ALL PASS — 6/6**（零 API） |
| Forensics 视图指向同一分歧块 | 与 M1/M4 run 文档方向一致（§3） |
| `docs/runs/l1-cache-forensics.md` 记录校验表 | 本文件 §2 |
| `docs/mechanisms/forensics.md` 讲解前缀模型 + 读图法 | 见 [`../mechanisms/forensics.md`](../mechanisms/forensics.md) |
| 提交 `L1: cache forensics` | 见 git log |

## 5. 约束遵守

- 只新增 / 只动 brief 允许的文件：`packages/core/src/context-diff.ts`（新）、
  `packages/core/src/index.ts`（**一行** append-only export）、
  `packages/server/scripts/forensics-experiment.ts`（新）、`apps/web/src/**`、
  两份新文档。
- 未改 `events.ts`、机制目录、其他 server 文件、其他文档、`package.json`/lockfile、`CONTRACT.md`。
- **未新增依赖**（分类器纯字符串处理，零 import 第三方）。
- **零 API 调用**（本里程碑不联网、不需要 `.env`）。
- `pnpm typecheck` 全包 green；web build green。

## 复现

```bash
pnpm install
pnpm --filter @agent/server exec tsx scripts/forensics-experiment.ts   # 零 API，应打印 ALL PASS
pnpm typecheck
pnpm --filter @agent/web build
# 打开 Web：选择一个有 ≥2 次请求的会话 -> Forensics 标签
```
