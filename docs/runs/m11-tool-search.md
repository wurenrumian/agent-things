# 实验记录 — M11 惰性工具暴露（tool search / code-mode facade）

**日期**：2026-10-04
**模型**：`xiaomi/mimo-v2.6-flash`（OpenRouter，脚本内固定，不读 `.env` 的 `OPENROUTER_MODEL`）
**命令**：

```bash
pnpm --filter @agent/server exec tsx scripts/tool-search-experiment.ts --salt=m11mimo001
# 只跑前缀探针（再取一组缓存样本）：
pnpm --filter @agent/server exec tsx scripts/tool-search-experiment.ts --only=probe --salt=m11mimo002
# 只验索引确定性，0 API 调用：
pnpm --filter @agent/server exec tsx scripts/tool-search-experiment.ts --index-only
```

> 复现方式：worktree `m11-tool-search` 里从主 worktree 复制 `.env`（gitignored，未提交），
> `pnpm install` 后执行上面的命令。脚本绕开 HTTP server，直接经 `OpenRouterClient`
> 打到 OpenRouter，所以两次运行之间**唯一变化的就是 request body**。温度 0，相邻调用间隔
> 500ms，固定 `session_id` 以启用 OpenRouter sticky routing（前缀缓存要求同 provider 实例命中）。

## 0. 方法

- **机制**：`packages/core/src/mechanisms/tool-search/**`（自包含，无依赖）
  - `tool-index.ts`：`ToolIndex` — 按 **name + description + parameter names** 建索引，
    关键词重叠打分（**无 embedding**），权重 name 4 / param 2 / desc 1，整名精确命中 +100；
    `search(query, limit)` 先按分数降序、再按 name `localeCompare` 排序，`entries()` 也按 name 排序。
    纯确定性：**输入顺序反转，输出完全一致**（见 §2）。
  - `facade.ts`：`createToolSearchTools(realTools)` 返回**恰好两个** `ToolDef`：
    - `tool_search(query)`：返回匹配工具的 `name(params)` 签名 + 描述文本；
    - `tool_call(name, arguments)`：按名查真实工具，未知名拒绝，执行并返回输出。
      另给 `createToolSearchRegistry(source)`，把一组真实工具（`ToolDef[]` 或整个
      `ToolRegistry`）包成**只含这两个 facade 工具**的 registry。
- **真实工具集（N=25）**：`builtinTools()`（5：read/write/edit/list/run_shell）+ 20 个
  「MCP-like」替身工具（文本工具 + `weather_current`/`translation_translate`/`currency_convert`/
  `calendar_list_events` 等远程服务样式）。全部纯函数、输出确定，两种模式拿到相同结果。
  N 个真实工具 **eager** 注入 = 25 个 schema；**lazy** 只注册 facade = 2 个 schema。
- **两段测量**：
  1. **前缀探针**：同一个长 system（`stableCorpus(90)`，超过 provider 最小可缓存块）+
     同一个 user，**每个模式连打 3 次完全相同的请求**，只改 `tools` 数组。读真实
     `usage.prompt_tokens` 与 `usage.prompt_tokens_details.cached_tokens`。
  2. **端到端任务**：同一个任务，真实 `Agent` 跑两遍——eager（25 工具 registry）vs
     lazy（只含 facade 的 registry），逐调用记录 usage，并检查任务是否完成。

## 1. 索引确定性（0 API 调用）

`--index-only` 把 `REAL_TOOLS` 原序与**反转序**分别建 `ToolIndex`，两者 `entries()`
与 5 个 query 的 `search()` 结果逐字节相同：

```
entries() identical for original vs reversed input: PASS
search("count words")      -> word_count(8), word_frequency(4), title_case(1)      [stable]
search("reverse a string") -> reverse_string(8), edit_file(2), json_format(1), ... [stable]
search("weather in a city")-> weather_current(6), edit_file(1), html_escape(1), ... [stable]
search("base64")           -> base64_decode(4), base64_encode(4)                  [stable]
determinism: PASS
index size: 25 tools
facade tools: tool_call, tool_search
```

关键词重叠就能把正确工具排到第一（`count words` → `word_count`、`reverse a string` →
`reverse_string`），无需 embedding。这是 facade 能保持前缀稳定的前提：同样的工具集和
同样的 query，甚至工具以不同顺序注册，输出都不变。

## 2. 前缀 token / 缓存账（每个模式 3 次相同调用）

### 2.1 run `m11mimo001`

**eager — 25 个 tool schema**

| call | label | prompt | **cached** | cache_write | hit% | cost($) |
|---|---|---|---|---|---|---|
| 1 | eager-probe#1 | 4777 | 0 | 0 | 0.0 | 0.000567 |
| 2 | eager-probe#2 | 4777 | **4736** | 0 | **99.1** | 0.000021 |
| 3 | eager-probe#3 | 4777 | 0 | 0 | 0.0 | 0.000568 |

**lazy — 2 个 facade schema**

| call | label | prompt | **cached** | cache_write | hit% | cost($) |
|---|---|---|---|---|---|---|
| 1 | lazy-probe#1 | 3100 | 0 | 0 | 0.0 | 0.000369 |
| 2 | lazy-probe#2 | 3100 | 0 | 0 | 0.0 | 0.000369 |
| 3 | lazy-probe#3 | 3100 | **3040** | 0 | **98.1** | 0.000018 |

### 2.2 run `m11mimo002`（重复样本）

**eager**

| call | label | prompt | **cached** | hit% |
|---|---|---|---|---|
| 1 | eager-probe#1 | 4777 | 0 | 0.0 |
| 2 | eager-probe#2 | 4777 | 1888 | 39.5 |
| 3 | eager-probe#3 | 4777 | **4736** | **99.1** |

**lazy**

| call | label | prompt | **cached** | hit% |
|---|---|---|---|---|
| 1 | lazy-probe#1 | 3100 | 0 | 0.0 |
| 2 | lazy-probe#2 | 3100 | **3040** | **98.1** |
| 3 | lazy-probe#3 | 3100 | 0 | 0.0 |

### 2.3 读法

- **前缀大小**：同一个 system + user 下，eager `prompt=4777`，lazy `prompt=3100`，
  facade 把常驻前缀压到 **−1677 token（−35.1%）**。25 个 schema 相对 2 个 facade schema，
  边际 ≈ **73 token/工具**（本次 fixture 描述较短；M4 用更长的 schema 实测 ≈165 token/工具，
  真实 MCP 工具的节省会更大）。
- **缓存效果**：两个模式在**请求一字未改**时都能预热到稳定命中——eager 峰值 **4736/4777
  = 99.1%**，lazy 峰值 **3040/3100 = 98.1%**。单次 `cached=0` 的行是 provider 侧缓存抖动
  （与 `m1 §1.4`、`m4 §3a` 观察到的 512/0 中间态同源），下一/上一行即回到 ~98–99%。
- **为什么 lazy 前缀稳定**：常驻前缀只由 `system` + **两个固定不变的 facade schema** 组成，
  与实际拥有多少个真实工具**无关**。搜索命中的 schema 和工具输出都作为 **tool result 追加在
  消息数组尾部**，前缀不动。反观 eager：工具集**成员或顺序**一变，已缓存前缀从改动点起全失效
  （M4 §3b：只重排顺序 cached 3456→0；§3a：+1 工具 cached 3328→0/640）。

## 3. 端到端任务：同一任务，eager vs lazy

任务（两模式完全相同）：

> 1. 数出 `"the quick brown fox jumps over the lazy dog"` 的词数；
> 2. 反转字符串 `"agent"`；
> 若不确定用哪个工具，先搜索再调用；最后一行输出 `words=<n> reversed=<s>`。

### 3.1 eager（注册全部 25 个工具）

| call | prompt | cached | hit% | cost($) |
|---|---|---|---|---|
| 1 | 2219 | 0 | 0.0 | 0.000274 |
| 2 | 2292 | 2176 | 94.9 | 0.000036 |
| **合计** | 4511 | 2176 | — | **0.000310**（2 calls） |

工具调用（第 1 步并行发出）：

```
word_count({"text":"the quick brown fox jumps over the lazy dog"}) -> {"words":9,"characters":43}
reverse_string({"text":"agent"}) -> {"reversed":"tnega"}
```

最终答案 `words=9 reversed=tnega` — **任务完成**。

### 3.2 lazy（只注册 `tool_search` + `tool_call`）

| call | prompt | cached | hit% | cost($) |
|---|---|---|---|---|
| 1 | 543 | 0 | 0.0 | 0.000075 |
| 2 | 966 | 0 | 0.0 | 0.000134 |
| 3 | 1065 | 0 | 0.0 | 0.000130 |
| **合计** | 2574 | 0 | — | **0.000339**（3 calls） |

工具调用：

```
tool_search({"query":"count words reverse string"}) -> Found 7 matching tool(s): - reverse_string(...) ...
tool_search({"query":"text manipulation"})          -> Found 8 matching tool(s): - truncate_text(...) ...
tool_call({"name":"word_count","arguments":{...}})  -> {"words":9,"characters":43}
tool_call({"name":"reverse_string","arguments":{...}}) -> {"reversed":"tnega"}
```

最终答案 `words=9 reversed=tnega` — **任务完成**。

### 3.3 账本对照

| 指标 | eager | lazy |
|---|---|---|
| 注册的工具 | 25 | 2（facade） |
| 常驻前缀（探针） | 4777 | 3100 |
| 前缀节省 | — | **−1677（−35.1%）** |
| 任务 API 调用 | 2 | 3 |
| 任务 prompt 合计 | 4511 | **2574（−42.9%）** |
| 任务 total token | 4625 | **2714（−41.3%）** |
| 任务成本 | **$0.000310** | $0.000339 |
| 任务完成 | ✅ | ✅ |

- **token 上**：lazy 任务总 token 少 **41.3%**，主因是常驻前缀从 4777 压到 3100，
  且每个后续调用的历史里都不再重复携带 25 份 schema。
- **成本上**：N=25、任务很短时两者接近（lazy 略贵 ~9%）。原因是 lazy **多一次搜索往返**，
  而 eager 的第 2 次调用靠缓存把昂贵前缀几乎全免（cached 2176，单价极低）。这正好量化了
  权衡：**省下的前缀要够大、或会话要够长（每轮累积），lazy 的净收益才盖过那次往返。**
  会话 3 轮的前缀账：eager `4777×3=14331` vs lazy `3100×3=9300`，省 **5031 token**。
- **lazy 任务里 `cached=0` 并非缓存失效**：`Agent` 的默认 system prompt 很短
  （lazy 首调用 `prompt=543`），整段前缀低于 provider 的最小可缓存块，所以不触发缓存命中；
  探针里把 system 拉长到超阈值后，lazy 稳定命中 98.1%（§2）——**即使缓存完全不命中，
  lazy 的前缀也只有 543 token，本就不值得缓存。**

## 4. 结论 — 回答 brief 的三问

1. **facade 相对 eager N 工具注入省多少 token？**
   本次 N=25：常驻前缀 **4777 → 3100（−1677，−35.1%）**，边际 ≈73 token/工具；
   直接按 M4 的 ~165 token/工具外推，真实（描述更长）MCP 工具可省 `~165×(N−1)` 级别。
2. **facade 是否让前缀跨轮保持稳定？为什么？**
   是。常驻前缀 = `system` + 两个**固定** facade schema，拥有多少真实工具都不改变它；
   搜索命中的 schema 与工具输出都**追加在尾部**（tool result），已缓存前缀不动。
   实测两个模式在请求不变时都能稳定命中（eager 99.1% / lazy 98.1%）；而 eager 一旦
   增删/重排工具集，前缀立即失效（M4 §3b/§3a）。
3. **权衡：多一次搜索往返 vs 更小更稳的前缀。**
   lazy 多 1 次 `tool_search` 往返（任务 3 calls vs 2），在 N 小、任务短时成本可能略高；
   但前缀更小且对工具集变化免疫。结论：**工具很多、单轮只用少数、且会话较长**时走 lazy；
   工具很少或每轮都要用大部分工具时，eager 更直接。二者都要求确定性排序（本机制的
   `entries()`/`search()` 与 `ToolRegistry.list()` 一致）。

## 5. 约束遵守

- 新增依赖 **0**；只新增 `packages/core/src/mechanisms/tool-search/**`、
  `packages/server/scripts/tool-search-experiment.ts` 与本篇 + 教学文档。
- **未改任何已有 core/server/web 文件、`package.json`、`docs/CONTRACT.md`**（`git status` 仅新文件）。
- `.env` 仅工作区本地复制，`.gitignore` 覆盖，未提交。
- API 调用：run `m11mimo001` 11 次 + run `m11mimo002` 6 次 = **17 次**（上限 30），未触发 429。
- `pnpm typecheck` 全包 green。

## 复现

```bash
cp D:/Project/agent-things/.env ./.env      # gitignored
pnpm install
pnpm --filter @agent/server exec tsx scripts/tool-search-experiment.ts --salt=m11mimo001
pnpm --filter @agent/server exec tsx scripts/tool-search-experiment.ts --only=probe --salt=m11mimo002
pnpm --filter @agent/server exec tsx scripts/tool-search-experiment.ts --index-only
pnpm typecheck
```
