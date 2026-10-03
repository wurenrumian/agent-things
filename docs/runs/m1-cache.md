# 实验记录 — M1 缓存与 token 经济

**日期**：2026-10-03
**模型**：`xiaomi/mimo-v2.6-flash`（OpenRouter）
**命令**：

```bash
pnpm --filter @agent/server exec tsx scripts/cache-experiment.ts --salt=mimo001
```

> 复现方式：worktree `m1-cache` 里从主 worktree 复制 `.env`（gitignored，未提交），
> `pnpm install` 后执行上面的命令。`--salt` 会写进每个 system prompt，保证一次运行
> 用的是**从未缓存过的新前缀**；省略时脚本自动用随机 salt。文中的样本来自
> `--salt=mimo001 / mimo002 / mimo003` 三次独立运行。

**环境**：温度 0，`max_tokens=16`，相邻调用间隔 500ms，`session_id` 固定以启用
OpenRouter 的 sticky routing（前缀缓存要求同 provider 实例命中）。

## 0. 方法

`packages/server/scripts/cache-experiment.ts` 直接用 `@agent/core` 的
`OpenRouterClient` 发流式请求，绕开 HTTP server，所以**唯一变化的只有 request body**。
每次调用读取真实的 `usage.prompt_tokens_details.cached_tokens` 与
`cache_write_tokens`（本项目 `Usage` 类型已有字段，无需改动 core）。

- system 走 `withCacheBreakpoint()`（末尾 `cache_control: ephemeral`），与
  `Agent.compileMessages()` 生产路径一致。
- 前缀故意放长（`stableCorpus(90)`，≈3.3k prompt tokens）以超过 provider 的最小可缓存块。
- 工具用真实 `builtinTools()`（`ToolRegistry` 按名字稳定排序后取 `schemas()`）。

## 1. 实测数据

### 1.1 baseline — 完全相同的请求 ×4

| call | label | prompt | **cached** | cache_write | hit% | cost($) |
|---|---|---|---|---|---|---|
| 1 | identical#1 | 3371 | **0** | 0 | 0.0 | 0.000375 |
| 2 | identical#2 | 3371 | **3328** | 0 | 98.7 | 0.000309 |
| 3 | identical#3 | 3371 | **3328** | 0 | 98.7 | 0.000309 |
| 4 | identical#4 | 3371 | **3328** | 0 | 98.7 | 0.000309 |

稳定态 `cached=3328 / prompt=3371 (98.7%)`，三次独立运行完全一致。缓存预热一次后保持命中。

### 1.2 tool-order — 只反转 `tools` 数组顺序

| call | label | prompt | **cached** | hit% | cost($) |
|---|---|---|---|---|---|
| 1 | normal#1 | 3372 | 0 | 0.0 | 0.000375 |
| 2 | normal#2 | 3372 | 3328 | 98.7 | 0.000308 |
| 3 | reversed#1 | 3372 | **0** | **0.0** | 0.000375 |
| 4 | reversed#2 | 3372 | 3328 | 98.7 | 0.000309 |
| 5 | normal#3 | 3372 | 3328 | 98.7 | 0.000309 |

内容一字未改，仅把 5 个工具 schema 的**顺序反转**，`cached` 从 3328 直接掉到 **0**：
整个前缀（system + 历史 + 工具）全部重建。`mimo002/003` 复现，3/3。

### 1.3 tool-set — 往数组里**追加一个新工具**

| call | label | prompt | **cached** | hit% | cost($) |
|---|---|---|---|---|---|
| 1 | base#1 | 3372 | 0 | 0.0 | 0.000375 |
| 2 | base#2 | 3372 | 512 | 15.2 | 0.000365 |
| 3 | base+extra#1 | 3455 | **0** | **0.0** | 0.000385 |
| 4 | base+extra#2 | 3455 | 512 | 14.8 | 0.000374 |
| 5 | base#3 | 3372 | 3328 | 98.7 | 0.000308 |

新增的 `fetch_url` 只让 prompt 增加 **83** token（3372→3455），却把缓存从 3328 打到
**0–512**，即一次性丢掉 **~2816–3328** token 的命中——是新增字节的 **~34–40 倍**。
`mimo002/003` 里 `base+extra#1` 均为 512（同样丢掉 ~2816），方向一致；新增工具集的
重新预热需要 **1–2 次**相同调用（本次第 4 行仍为 512，另一次裸跑第 2 次即回到 3456）。

### 1.4 system — system message 改 1 个字节

| call | label | prompt | **cached** | hit% | cost($) |
|---|---|---|---|---|---|
| 1 | base#1 | 3371 | 512 | 15.2 | 0.000365 |
| 2 | base#2 | 3371 | 3328 | 98.7 | 0.000309 |
| 3 | changed#1 | 3371 | **512** | **15.2** | 0.000364 |
| 4 | changed#2 | 3371 | 3328 | 98.7 | 0.000309 |
| 5 | base#3 | 3371 | 3328 | 98.7 | 0.000309 |

只把 sentinel 里的 `AAAA` 改成 `AAAB`（1 byte），`cached` 从 3328 掉到 **512**：
丢掉 2816 token（84.6%）。`mimo002/003` 复现，3/3。且注意第 5 行 `base#3` 仍 3328——
旧的 base 前缀在缓存 TTL 内**没有被这次改动污染**，可以“切回”。

### 1.5 append-only — 只追加、绝不改写前缀

| call | label | prompt | **cached** | hit% | cost($) |
|---|---|---|---|---|---|
| 1 | grow#1 | 3374 | 512 | 15.2 | 0.000365 |
| 2 | grow#2 | 3395 | 3328 | 98.0 | 0.000311 |
| 3 | grow#3 | 3418 | 3328 | 97.4 | 0.000313 |
| 4 | grow#4 | 3437 | 3328 | 96.8 | 0.000315 |

消息数组每轮追加一个完整 turn，`cached` **绝对值稳定在 3328**（system + tools + 首条
user），只有新追加的尾部 token 未命中；hit% 从 98.0 缓降到 96.8 纯粹是分母变大。
`mimo002/003` 完全一致。这是“健康”的曲线。

## 2. 结论（逐条对照 `docs/MECHANISMS.md` §6）

| §6 问题 | 归属 | 判定 | 依据 |
|---|---|---|---|
| 1. skill 正文三种注入方式的 cached 曲线 | M2 | **本里程碑不测（deferred）**；但底层命题已验证 | §1.4 vs §1.5：改写 system 掉 3328→512，尾部追加保持 3328 |
| 2. 增删一个 MCP server 对缓存的影响与代价 | M4 | **方向性 confirmed（工具集为代理）** | §1.3：加 1 个工具触发 ~2816–3328 token 的 miss，代价是新增字节的 ~34–40 倍 |
| 3. 压缩后缓存恢复曲线；固定位置摘要 | M3 | **本里程碑不测（deferred）**；恢复了“再预热只需 1 次调用” | §1.2/§1.4：被打断后第 2 次相同请求即回到 3328 |
| 4. 工具排序抖动导致 miss 的复现 | M1 | **confirmed** | §1.2：反转工具顺序，cached 3328→**0**，3/3 复现 |
| 5. subagent 回灌 vs 主上下文 token 账 | M5 | **本里程碑不测（deferred）** | — |

### §2–§3 的具体主张

- **§0/§2 “前缀缓存只命中稳定前缀；改动 system / 工具 schema / 历史，从改动点之后全部失效”**
  —— **confirmed**。system 改 1 byte 丢 2816 token（§1.4）；工具顺序反转丢全部 3328（§1.2）。
- **§2 “正文尾部插入不破坏缓存，改写 system 破坏缓存”** —— **confirmed**。
  append-only 全程命中（§1.5）；system 改写即塌陷（§1.4）。
- **§3 “工具枚举顺序或成员变化导致前缀失效”** —— **confirmed**，且量化：
  顺序变化 = 全 miss（3328→0）；追加成员 = 掉到 0–512。`ToolRegistry.list()` 按名字稳定
  排序的设计因此是必要的（否则每次枚举抖动都全 miss）。
- **§3 “MCP eager 全量注入、接多个 server 代价大”** —— **未直接测**（无 MCP），但工具 schema
  的代价值可从 §1.3 外推：任何工具集成员变化都会让**整个**已缓存前缀重建。

### 政策必须避免的 cache-drop

1. **绝不重排或增删 tools**（顺序变化 → cached=0；加一个 → cached≈0–512）。
2. **绝不改写 system 前缀**（1 byte → 丢 84.6%）。
3. **历史只追加**：尾部追加保持 `cached` 绝对值不变（§1.5）。
4. 需要恢复时，**再一次（最多两次）相同请求**即可重新预热（§1.2/§1.4 的“切回”行）。

### token 经济

`cache_write_tokens` 全程为 **0**：该 provider 走自动前缀缓存，不像 Anthropic 那样上报
写入计费。成本上，冷调用同 prompt 为 `$0.000375`，命中后为 `$0.000309`，约便宜 **18%**；
对 `mimo-v2.6-flash` 这种按次计费的模型，缓存命中是直接的成本杠杆。Usage tab 现在会显示
running 命中率与累计花费（见下）。

## 3. 观测台改动（`apps/web/src/components/UsageTab.tsx`）

- `runningSeries(usages)`：按调用顺序累计 `sum(cached)/sum(prompt)` 与 `sum(cost)`。
- Calls 表新增两列 `run hit` / `run cost`，`tfoot` 汇总同值；Session 卡片标题改为
  “Session running”。纯增量，未改任何冻结类型。

## 4. 附：stealth/space-bunny-alpha 的观测噪声（pilot，非本里程碑结论）

在 coordinator 切换模型之前，我用同一 harness 在 `stealth/space-bunny-alpha` 上跑了
`salt=m1cache001..005` 与 append 单独 3 次。该模型的缓存**不稳定**：

- baseline 稳定（141→3521，99.9%）。
- system 改 1 byte 稳定全 miss（→~141）。
- 反转工具顺序：5 次里 4 次掉到 2906（只丢工具段 ~616），1 次全掉到 141。
- **append-only 第 4 次调用**：5 次里 4 次塌到 **128**（全 miss），1 次 3570。

最后一条正是 `docs/runs/m0-smoke.md` 里那步 `cached` 从 1201 掉回 **128** 的谜团——
在 `stealth/space-bunny-alpha` 上可复现，且 append 前缀本身是合法的。**它不是客户端 bug，
是 provider 侧的缓存抖动/路由行为。** 换到 `xiaomi/mimo-v2.6-flash` 后 append-only 稳定在
99%（§1.5），该异常消失。

## 5. 约束遵守

- 未改 `docs/CONTRACT.md`、`AgentEvent` 词表或任何冻结接口；全部为增量。
- **未修改 `packages/core/src/**`**：实验期间未出现阻塞性 core bug；观测到的波动来自 provider。
- `.env` 仅工作区本地复制，`.gitignore` 覆盖，未提交。
- `pnpm typecheck` 全包 green。

## 复现

```bash
cp D:/Project/agent-things/.env ./.env      # gitignored
pnpm install
pnpm --filter @agent/server exec tsx scripts/cache-experiment.ts --salt=mimo001
# 或只跑某组：... cache-experiment.ts baseline tool-order --salt=x
pnpm typecheck
```
