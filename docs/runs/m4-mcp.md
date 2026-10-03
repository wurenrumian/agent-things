# 实验记录 — M4 MCP 上下文管理

**日期**：2026-10-03
**模型**：`xiaomi/mimo-v2.6-flash`（OpenRouter）
**命令**：

```bash
pnpm --filter @agent/server exec tsx scripts/mcp-experiment.ts --salt=m4mcp001
# 复现关键场景（只跑 part 3a）：
pnpm --filter @agent/server exec tsx scripts/mcp-experiment.ts --only=add --salt=m4mcp002
```

> 复现方式：worktree `m4-mcp` 里从主 worktree 复制 `.env`（gitignored，未提交），
> `pnpm install` 后执行上面的命令。`--salt` 保证一次运行用从未缓存过的新前缀；
> `--only=cost,add,order` 可只跑子场景（`--roundtrip-only` 不花 API 调用）。

**环境**：温度 0，`max_tokens=16`，相邻调用间隔 500ms，`session_id` 固定以启用
OpenRouter sticky routing（前缀缓存要求同 provider 实例命中）。全部经
`OpenRouterClient` 直连，唯一变量是 request body。

## 0. 方法

- **手写 MCP client（无 SDK）**：`packages/core/src/mechanisms/mcp/`
  - `transport.ts`：`child_process.spawn` + 按 `\n` 切分的 JSON-RPC 2.0 帧、
    id 关联、error→reject、notification 丢弃、子进程退出时拒绝所有 pending。
  - `client.ts`：`initialize` 握手 + `notifications/initialized`，`tools/list`
    （带 `nextCursor` 翻页），`tools/call`；`mcpToolsToSchemas()` 按 name 排序。
- **fixture server（真实子进程）**：`fixtures/echo-server.mjs`，用 `node` 启动，
  按 `MCP_FIXTURE_TOOLS=N` 暴露 N 个 `echo_*` 工具。工具是**真的经 `tools/list`
  拉取**的，不是本地伪造的 schema。
- **测量**：`OpenRouterClient` 直连，读真实 `usage.prompt_tokens` 与
  `usage.prompt_tokens_details.cached_tokens`。system 走 `withCacheBreakpoint()`，
  前缀用 `stableCorpus(90)`（≈2.8k prompt token）超过最小可缓存块。

## 1. 真实 JSON-RPC 往返（stdio）

```
initialize -> protocolVersion=2024-11-05 server=m4-echo-fixture@0.0.0
tools/list -> 2 tools:
  - echo_1: Echo back a short text payload (fixture MCP tool #1). ...
  - echo_2: Echo back a short text payload (fixture MCP tool #2). ...
mcpToolsToSchemas(reversed input) -> echo_1, echo_2
tools/call echo_1 {text:"hello MCP",uppercase:true,repeat:2}
  -> isError=false content="echo(echo_1): HELLO MCPHELLO MCP"
```

- 握手、枚举、调用三类消息都经同一条 stdin/stdout 管道真实往返。
- **确定性映射**：把 `tools/list` 结果**反转**后再 `mcpToolsToSchemas()`，输出仍是
  `echo_1, echo_2`——顺序只由 name 决定，与 server 枚举顺序无关。

## 2. 注入 N 个 MCP 工具的 token 成本（`prompt_tokens`）

同一 system + 同一 user，只改 `tools` 数组：

| N | prompt | cached | Δ vs N=0 | 边际 |
|---|---|---|---|---|
| 0 | 2842 | 0 | — | — |
| 1 | 3023 | 0 | **+181** | +181 / tool |
| 5 | 3675 | 0 | **+833** | ~163 / tool |
| 20 | 6142 | 0 | **+3300** | ~165 / tool |

- 首个工具含“启用 tools 数组”的固定开销（≈16 token），之后**每个 MCP 工具
  ≈163–165 token**，线性增长。
- N=20 时 prompt 从 2842 → 6142，**翻了 1.16 倍**（+116%），而这 20 个还都是短
  description 的 echo 工具；真实 server 的工具描述常有数百 token，20 个 server
  轻松吃掉数万 token（与 `MECHANISMS §3` 的说法一致）。
- 这些 token **每轮请求都重新计费**（eager 全量注入），与是否调用工具无关。

## 3. 缓存影响（`cached_tokens`）

对照 `docs/runs/m1-cache.md` §1.3（工具集成员变化）。

### 3a 往热集合**追加 1 个 MCP 工具**

| run | label | prompt | cached | hit% | cost($) |
|---|---|---|---|---|---|
| A `m4mcp001` | base#1 | 3376 | 0 | 0.0 | 0.000375 |
| A | base#2 | 3376 | **3328** | 98.6 | 0.000309 |
| A | base+mcp#1 | 3545 | **0** | **0.0** | 0.000394 |
| A | base+mcp#2 | 3545 | 3456 | 97.5 | 0.000324 |
| A | base#3 | 3376 | 3328 | 98.6 | 0.000309 |
| B `m4mcp002` | base#2 | 3376 | **3328** | 98.6 | 0.000309 |
| B | base+mcp#1 | 3545 | **640** | 18.1 | 0.000381 |
| B | base+mcp#2 | 3545 | 3456 | 97.5 | 0.000324 |
| B | base#3 | 3376 | 3328 | 98.6 | 0.000309 |

- 追加 1 个 MCP 工具只让 prompt **+169** token（3376→3545），却把命中从 **3328**
  打到 **0（run A）/ 640（run B）**，一次丢掉 **2688–3328** token——是新增字节的
  **~16–20 倍**。方向与 m1 §1.3（+83 token → 掉 2816–3328）完全一致。
- 第 4 行一次相同请求即重新预热到 3456；第 5 行切回 base 又拿回 3328——旧前缀在
  TTL 内**未被污染**，可以切回（同 m1 §1.4 的“切回”行为）。

### 3b 同一工具集**只重排顺序**

（成员不变，仅把 MCP 工具从末尾挪到最前）

| label | prompt | cached | hit% | cost($) |
|---|---|---|---|---|
| normal#1 | 3545 | 512 | 14.4 | 0.000383 |
| normal#2 | 3545 | **3456** | 97.5 | 0.000324 |
| reordered#1 | 3545 | **0** | **0.0** | 0.000394 |
| reordered#2 | 3545 | 3456 | 97.5 | 0.000324 |

- 内容一字未改，仅顺序变化：cached **3456 → 0**，整个前缀（system + tools）重建。
  复现 m1 §1.2（反转 5 个工具 → 3328→0）。
- `normal#1` 的 512 是 provider 侧部分命中抖动（m1 亦观察到 512 的中间态），不影响
  结论：稳定态 warm 后重排必全 miss。

## 4. 结论 — 对照 `docs/MECHANISMS.md`

### §6 Q2：增删一个 MCP server 对缓存的具体影响与代价

**已实测（confirmed）**。接入/移除一个 MCP server = 改工具集成员 = 工具 schema
前缀段变化 → 已缓存前缀**从改动点起全部失效**。

- 代价量化：在当前 ~3.4k 前缀下，**+1 个工具 → 丢掉 2688–3328 cached token**，
  而新增字节只有 ~169 token，**放大约 16–20 倍**。
- 恢复：**1 次相同请求**即可重新预热（`base+mcp#2` 回到 3456）。
- 切回旧集合仍命中（`base#3`=3328），说明是“换了一条前缀”，不是污染。

### §3 MCP 主张

| §3 主张 | 判定 | 依据 |
|---|---|---|
| MCP 是 eager，所有工具元数据每轮全量注入 | **confirmed** | §2：不加调用也每轮计费；N=20 → +3300 token |
| 接多个 server 可能吃掉数万 token | **confirmed（外推）** | §2 短工具 ≈165 tok/个；真实描述更大 |
| 工具枚举**顺序**变化 → 前缀失效 | **confirmed** | §3b：3456 → 0 |
| 工具**成员**变化 → 前缀失效 | **confirmed** | §3a：3328 → 0/640 |
| 用确定性排序规避枚举抖动 | **已落实** | §1：反转输入 → 输出 `echo_1, echo_2` |

### §3“工具搜索 / 代码执行式调用”能压到多少

本里程碑只覆盖 eager 基线，未实现惰性方案；从 §2 数据可见，把 N 个工具描述压成
1 个“工具搜索”入口，可省下 `~165 × (N−1)` token/轮。设计取舍见
[`docs/mechanisms/mcp.md`](../mechanisms/mcp.md)。

## 5. 政策含义（回填 MECHANISMS）

1. **schema 注入必须确定性排序**：`mcpToolsToSchemas()` 按 name 排序，与
   `ToolRegistry.list()` 一致（m1 §1.2 已证明乱序 = 全 miss）。
2. **会话中途绝不动态增删 MCP 工具**：等价于改工具集，代价是整段前缀 miss。
   若不可避免，接受 1 次重新预热即可恢复。
3. **能惰性则惰性**：eager 注入的成本随 server/工具数线性上涨；对“工具极多、
   单轮只用少数”的场景，应改走渐进披露（工具搜索 / 代码执行式调用），把常驻
   工具描述压到最小。
4. **resources / prompts 与 tools 注入时机不同**，本实验未覆盖，留作后续。

## 6. 约束遵守

- 新增依赖 **0**（无 `@modelcontextprotocol/sdk`），只新增
  `packages/core/src/mechanisms/mcp/**`、`scripts/mcp-experiment.ts` 与新文档。
- 未改任何已有 core/server/web 文件、`package.json`、`docs/CONTRACT.md`。
- `.env` 仅工作区本地复制，`.gitignore` 覆盖，未提交。
- API 调用：run A 13 次 + run B 5 次 = **18 次**（上限 ~20）；含 429 退避重试逻辑。
- `pnpm typecheck` 全包 green。

## 复现

```bash
cp D:/Project/agent-things/.env ./.env      # gitignored
pnpm install
# 全量（往返 + 成本 + 缓存）
pnpm --filter @agent/server exec tsx scripts/mcp-experiment.ts --salt=m4mcp001
# 只验往返（0 API 调用）
pnpm --filter @agent/server exec tsx scripts/mcp-experiment.ts --roundtrip-only
# 只复现缓存追加场景
pnpm --filter @agent/server exec tsx scripts/mcp-experiment.ts --only=add --salt=m4mcp002
pnpm typecheck
```
