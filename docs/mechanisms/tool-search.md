# 机制讲解 — 惰性工具暴露（tool search / code-mode facade）

> 配套实测数据见 [`docs/runs/m11-tool-search.md`](../runs/m11-tool-search.md)；
> 基础证据见 [`docs/runs/m4-mcp.md`](../runs/m4-mcp.md)（eager 注入 ≈165 token/工具、
> 成员/顺序变化导致前缀全 miss）与 [`docs/runs/m1-cache.md`](../runs/m1-cache.md)。
> 问题来源：[`docs/MECHANISMS.md`](../MECHANISMS.md) §3「工具搜索 / 代码执行式调用」。

## 1. 问题：eager 注入的两笔账

MCP 的默认模型是 **eager（急切）** 的：**所有工具的完整 JSON schema，每一轮请求都全量
塞进 `tools` 数组**，无论这轮用不用得到。这带来两笔账：

1. **上下文成本**：工具描述常驻，随工具数**线性上涨**，且**每轮重复计费**
   （M4 实测 ≈165 token/工具；20 个短工具就能让 prompt 从 2842 涨到 6142）。
2. **缓存风险**：`tools` 是前缀缓存哈希的一部分。**成员一变**（接/断一个 MCP server）或
   **顺序一变**，已缓存前缀从改动点起**全部失效**——M4 §3b 只重排顺序就 cached `3456→0`，
   §3a 加 1 个工具 cached `3328→0/640`，而新增字节只有 ~169 token。

一句话：**N 个工具里单轮只用少数**时，eager 是「把整个 toolbox 搬到桌上，却只拧一颗螺丝」。

## 2. 思路：常驻小索引 + 按需加载正文

惰性暴露（lazy exposure，也叫渐进披露 / progressive disclosure）把工具的「元数据」与
「正文」拆开：

- **常驻（稳定前缀）**：一个极小的**可搜索入口**。模型每轮都看得到「我有一个搜索框」，
  但看不到任何真实工具的完整 schema。
- **按需（尾部）**：模型需要某能力时，先**搜索**，拿到匹配工具的**签名 + 描述**；
  再用统一的 **`tool_call`** 执行。搜索命中的 schema 和工具输出都是 **tool result**，
  追加在消息数组**尾部**，不重写已缓存前缀（与 M2 skill 正文「尾部插入」同理）。

M11 把常驻入口做成**恰好两个** `ToolDef`：

| 工具 | 作用 | 何时进入上下文 |
|---|---|---|
| `tool_search(query)` | 关键词搜索真实工具，返回 `name(params)` 签名 + 描述 | 模型主动调用时，结果落在尾部 |
| `tool_call(name, arguments)` | 按名查真实工具、拒绝未知名、执行并返回输出 | 模型主动调用时，结果落在尾部 |

父 `Agent` 只注册这两个工具，于是 **N 份真实 schema 永远不进请求前缀**。

## 3. `ToolIndex`：确定性关键词排序（无 embedding）

实现见 `packages/core/src/mechanisms/tool-search/tool-index.ts`。

### 3.1 索引哪些字段

每个 `ToolDef` 索引三处文本：

- **name**：`read_file` → `["read","file"]`（按 `_`/`-`/camelCase 切分）；
- **parameter names**：`path`、`offset`、`limit`；
- **description**：整句分词。

打分是**关键词重叠**，不做向量检索、不调用外部服务：

```
对每个 query token：
  name 命中  -> +4
  param 命中 -> +2
  desc 命中  -> +1
整名精确匹配（去分隔符后相等）-> +100
```

name 权重最高，因为工具名是最强信号；参数名次之；描述最弱、只做兜底。
`words` 与 `word`、`counting` 与 `count` 通过**双向前缀容差**匹配（≥3 字符），
不需要真正的词干器。

### 3.2 为什么必须确定性

facade 的输出会被塞回上下文；如果同样的工具集、同样的 query 每次排序不同，
模型的后续行为就不稳定，前缀也可能受牵连。因此：

- 构造时按 name 排序并去重（同名后者覆盖，和 `ToolRegistry.register` 一致）；
- 打分后按 **(分数降序, name `localeCompare` 升序)** 排序，**绝不依赖输入顺序**；
- `entries()` 也按 name 排序。

实测把真实工具**反转序**输入，`entries()` 与 5 个 query 的 `search()` 结果逐字节相同。

### 3.3 公开 API

```ts
class ToolIndex {
  constructor(tools: ToolDef[]);
  size(): number;
  entries(): ToolIndexEntry[];              // 按 name 排序
  get(name: string): ToolIndexEntry | undefined;
  search(query: string, limit = 8): ToolMatch[];   // 分数降序、name 平局
}
// ToolMatch = { name, description, signature, parameters, score }
```

`signature` 形如 `read_file(path: string, offset?: integer, limit?: integer)`
（参数按 name 排序，可选参数带 `?`）。

## 4. facade：`createToolSearchTools(realTools)`

实现见 `packages/core/src/mechanisms/tool-search/facade.ts`。返回**恰好两个** `ToolDef`：

### `tool_search(query, limit?)`

- `readOnly: true`。
- 调 `ToolIndex.search`，把命中渲染成文本：
  ```
  Found N matching tool(s) for "<query>":
  - reverse_string(text: string)
    Reverse the characters of a string. ...
  ```
- 无命中时返回一句「换个关键词」提示，不报错。

### `tool_call(name, arguments)`

- `readOnly: false`（它会执行真实工具）。
- 用 `name` 在真实工具表里查；**未知名一律拒绝**，提示改用 `tool_search` 发现工具，
  **不泄露完整工具清单**（否则惰性暴露就漏了）。
- `arguments` 同时接受**对象**和**JSON 字符串**（有些模型会双重编码），非法则返回可纠正的错误。
- 执行真实工具的 `execute(args, ctx)`，把 `ctx`（cwd/signal/turnId/sessionId/checkpoints）原样透传。
- 额外产出一个 `mechanism` 事件（`name: "tool-search"`, `phase: "tool_call"`）供观测台展示，
  真实工具自己的 `events` 也一并转发。

### 装配（给后续 integration wave）

```ts
import { createToolSearchRegistry } from "./mechanisms/tool-search/index.js";

const tools = createToolSearchRegistry(realRegistry); // 真实工具可以是 ToolDef[] 或整个 ToolRegistry
const agent = new Agent({ ...config, tools }, sessionId);
// agent 看得见的只有 tool_search / tool_call
```

`createToolSearchRegistry` 内部用 `ToolRegistry` 注册这两个工具，天然获得稳定 name 排序。

## 5. 缓存行为：为什么前缀是稳定的

- **常驻前缀** = `system` + **两个固定不变的 facade schema**。它**与实际拥有多少真实工具无关**：
  今天接 25 个、明天接 200 个，请求前缀一字不改。
- 搜索命中的工具 schema 与工具输出都是 **tool result**，追加在消息数组尾部；按 m1 §1.5，
  尾部追加让已缓存前缀的 `cached` **绝对值不变**。
- 对比 eager：只要 `tools` 成员或顺序变化，前缀立刻失效（M4 §3b/§3a）。

实测：请求完全不变时，eager 峰值命中 99.1%、lazy 98.1%；两者都能稳定命中，
但 lazy 的前缀更小，并且对「工具集变化」免疫。

## 6. 权衡：多一次往返 vs 更小更稳的前缀

惰性不是免费午餐：

- **多一次 `tool_search` 往返**：模型要先搜再调。M11 实测任务里 lazy 3 calls vs eager 2 calls。
- **成本**：N 小、任务短时，那次往返可能盖过前缀节省（实测 N=25 短任务：lazy 总 token −41.3%，
  但美元成本略高 ~9%，因为 eager 靠缓存把昂贵前缀几乎全免）。会话越长、N 越大，
  lazy 的每轮前缀节省越占优。
- **模型可能「不知道自己有什么」**：facade 的 description 与任务提示要引导它先搜；
  `tool_call` 的未知名错误要提示去搜，而不是回退成 eager。
- **权限被折叠**：facade 自身的 `readOnly=false` 驱动权限判断，无法区分底层工具是读是写。
  需要分工具权限的集成，应在 `tool_call` 外层按**解析出的真实工具**重新过权限（见
  `index.ts` 的 wiring 注释）。

**选型**：工具很多、单轮只用少数、会话较长 → lazy；工具很少、每轮几乎全用 → eager。

## 7. 落地规则（与本项目一致）

1. **确定性排序**：`ToolIndex` 与 `ToolRegistry.list()` 都按 name 稳定排序，绝不依赖枚举顺序。
2. **只追加、不改写**：搜索命中的 schema 走 tool result 尾部插入，不塞进 system、不重写前缀。
3. **拒绝未知名、不泄清单**：错误信息引导去 `tool_search`。
4. **纯函数、无依赖**：`ToolIndex` 只做字符串处理；facade 只做查表 + 透传。

## 参考

- [`docs/runs/m11-tool-search.md`](../runs/m11-tool-search.md) — 本机制的实测 token/缓存账本。
- [`docs/runs/m4-mcp.md`](../runs/m4-mcp.md) — eager 注入成本与缓存失效。
- [`docs/runs/m1-cache.md`](../runs/m1-cache.md) §1.3/§1.5 — 工具成员变化与尾部追加。
- [`docs/mechanisms/mcp.md`](./mcp.md) §2 — progressive disclosure 的动机。
- [`docs/mechanisms/skills.md`](./skills.md) — 同源的三级披露（L1/L2/L3）。
