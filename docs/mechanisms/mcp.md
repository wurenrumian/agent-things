# 机制讲解 — MCP 的上下文管理

> 配套实测数据见 [`docs/runs/m4-mcp.md`](../runs/m4-mcp.md)；
> 钩子问题来自 [`docs/MECHANISMS.md`](../MECHANISMS.md) §3 与 §6 Q2。

## 1. MCP 是什么（本项目需要的子集）

MCP（Model Context Protocol）本质是一套 **JSON-RPC 2.0 协议**，用来把外部能力
（工具、资源、提示）暴露给 agent。传输层这里用 **stdio**：客户端 `spawn` 一个子进程，
双方在 stdin/stdout 上写**按换行分隔的 JSON**，一行一条消息。

我们只实现三件事：

| 方法 | 作用 | 方向 |
|---|---|---|
| `initialize` | 协议版本 + capabilities 握手 | 请求/响应 |
| `tools/list` | 枚举可用工具（可 `nextCursor` 翻页） | 请求/响应 |
| `tools/call` | 调用某个工具 | 请求/响应 |

外加一条 `notifications/initialized`（无 id、无响应）。实现见
`packages/core/src/mechanisms/mcp/`：

- `transport.ts` — 帧切分 + **id 关联**：每个请求分配自增 id，用 `Map<id, pending>`
  把响应配回 Promise；notification 直接丢弃；子进程退出/出错时拒绝所有 pending。
- `client.ts` — `McpStdioClient`（`connect` / `listTools` / `callTool`）+
  `mcpToolsToSchemas()` 映射 + `fixtures/echo-server.mjs` 真实 fixture。

**为什么要手写、不用 SDK**：整个项目的目的就是“看见真正过线的字节”。SDK 会把
工具 schema、帧格式、错误处理都藏起来，正好挡住要研究的东西；这里手写约 200 行即可。

## 2. 核心矛盾：eager 注入 vs 渐进披露

MCP 的默认模型是 **eager（急切）** 的：**所有已连接 server 的全部工具元数据，每一轮
请求都全量注入 `tools` 数组**，无论这一轮用不用得到。这带来两笔账：

1. **上下文成本**：工具描述常驻，随 server / 工具数**线性上涨**，且每轮重复计费。
2. **缓存风险**：工具集是前缀缓存哈希的一部分；**枚举顺序或成员一变，前缀失效**。

实测（mimo-v2.6-flash，system ≈2.8k）：

| N 个工具 | prompt | Δ vs N=0 |
|---|---|---|
| 0 | 2842 | — |
| 1 | 3023 | +181 |
| 5 | 3675 | +833 |
| 20 | 6142 | +3300 |

- 边际 ≈ **165 token / 工具**，线性、无摊销。
- 追加 1 个工具（prompt 只 +169）→ cached **3328 → 0/640**，丢掉 ~16–20 倍新增字节。
- 只重排顺序（一字未改）→ cached **3456 → 0**。

### 渐进披露（progressive disclosure）

把“工具的完整描述”拆成**常驻的小索引** + **按需加载的正文**：

- 常驻：工具名 + 一句话描述（或一个 `search_tools` 入口）。
- 按需：真正要用某个工具时，才把它的完整 schema 插到消息数组**尾部附近**——这样
  已缓存的前缀不动（与 M2 skill 正文“尾部插入”同理）。

`MECHANISMS §3` 提到的“**工具搜索 / 代码执行式调用**”就是这个思路：把 N 个工具描述
压成 1 个入口，省下 `~165 × (N−1)` token/轮，同时消除成员抖动带来的 miss。

不过要注意权衡：渐进披露**多一次往返**（先搜再调），且模型可能“不知道自己有什么”。
所以它是“工具很多、单轮只用少数”时的解药，不是所有场景的默认。

## 3. 落地规则（本项目的实现）

1. **确定性排序**：`mcpToolsToSchemas()` 对 `tools/list` 结果按 name 排序后再映射。
   实测把输入**反转**，输出仍是稳定顺序——server 枚举抖动不再改前缀。
   （对应 `ToolRegistry.list()` 的既有约定。）
2. **会话中途不动态增删工具**：接/断一个 MCP server = 改工具集 = 整段前缀失效。
   真需要时接受 1 次重新预热（实测第 2 次相同请求即回到 ~97% 命中）。
3. **能追加就不改写**：与 Codex 的教训一致——把易变信息后置/追加，别重写稳定前缀。
4. **别把工具描述塞进 system**：无论放 `system` 还是 `tools`，只要在稳定前缀里，
   改动都会让其后全部失效；放 `tools` 至少符合 OpenAI 兼容协议的规范位置。

## 4. 实测之外的待办

- `resources` / `prompts` 与 `tools` 的注入时机不同，本里程碑未测（§3 明确要求分别测）。
- 工具搜索 / 代码执行式的实际压缩比与多一次往返的净成本，留作后续实验。
- 多 server 并存时的命名冲突与工具名前缀策略。

## 参考

- [`docs/runs/m4-mcp.md`](../runs/m4-mcp.md) — 本机制的实测数据。
- [`docs/runs/m1-cache.md`](../runs/m1-cache.md) §1.2/§1.3 — 同一缓存机制的基础证据。
- [`docs/MECHANISMS.md`](../MECHANISMS.md) §3/§6 — 钩子问题与真实来源。
