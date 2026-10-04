# MYTHS — 常识 vs 实测

这份文档收集本项目**用真实 API 数据推翻或修正过**的"常识"。每一条 belief 都写成同一个
四段结构：

> **常见说法 → 操作化问题 → 实测数字 → 结论**

规则：**每一个数字都逐字来自对应的 run 文档**，本页不发明任何数据。测量口径统一为
provider 真实返回的 `usage.prompt_tokens_details.cached_tokens` / `usage.prompt_tokens`
/ `usage.cost`（来自 `OpenRouterClient` 直连，绕开 HTTP server，唯一变量是 request body）。
模型除 M0 外均为 `xiaomi/mimo-v2.6-flash`（OpenRouter，自动前缀缓存）。

---

## 1. Skill 取用会不会炸 KV cache？(M2)

**常见说法**：取一次 skill 正文（`SKILL.md`）就会把已经缓存的 KV cache 打掉，所以 skill
这东西"看着省，其实把缓存炸了"。

**操作化问题**：在同一逻辑前缀上，把**同一份** skill 正文分别作为
(a) 尾部 `user` 消息、(b) `tool` result、(c) 塞进 **system 前缀内部**注入，
各自连续调用的 `cached_tokens` 会怎么走？

**实测数字**（`--salt=mimo-m2-001`；元数据 `<available_skills>` 256 chars 常驻，
正文 `code-review/SKILL.md` 2625 chars ≈ 657 tokens）：

| 注入方式 | 预热稳定命中 | 注入时 `cached` | 注入相对预热 |
|---|---|---|---|
| (a) 尾部 `user` 消息 | 3456/3578（96.6%） | **3456**（prompt 3578→4200，82.3%） | **不变** |
| (b) `tool` result（`use_skill`） | 3456/3578（96.6%） | **3456**（prompt 3578→4224，81.8%） | **不变** |
| (c) 改写 system（正文插进前缀内部） | 3456/3578（96.6%） | **0**（prompt 4204） | **全掉** |

(b) 的 `follow-tool` 达 **4224/4245（99.5%）**；(c) 的 `follow-system` 才回到 **640/4226
（15.1%）**，且注入那一次 cost `$0.000469`，比 (a)/(b) 的 `$0.000400` 更贵。

**结论**：**不会**。skill 被拆成"元数据常驻 + 正文按需注入"两半，正文走尾部 `user` 消息
或 tool result 时 `cached` 绝对值纹丝不动（3456），只有把它插进已缓存前缀内部才会塌。
"取 skill 炸不炸缓存"取决于**注入位置**，不取决于 skill 本身。
→ [`docs/runs/m2-skills.md`](runs/m2-skills.md)

---

## 2. "改 system 就一定失效"？(M1 / M2 的修正)

**常见说法**：只要 system prompt 变了，前缀缓存必然全灭，因为 system 在最前面。

**操作化问题**：system 的变化是"在前缀**内部**非追加地改一个字节"，还是"把新内容**追加到
system 末尾**"？两种改法的 `cached_tokens` 各是多少？

**实测数字**：

- M1 §1.4：把 system 里 sentinel 的 `AAAA` 改成 `AAAB`（**1 byte**），`cached` 从
  **3328 掉到 512**，丢掉 2816 token（**84.6%**），`mimo002/003` 复现 3/3。
- M2 (c)：同一份正文**插进 system 靠前位置**（后续所有字节前移），`inject-system` 的
  `cached` 从预热态 3456 **直接到 0**。
- M2 (c′)：同一份正文**追加到 system 最末尾**，`inject-system` 的 `cached` 仍保持
  **3456**（82.2%），`follow-system` **4096/4226（96.9%）**。
- M1 §1.5：消息数组每轮只追加一个 turn，`cached` 绝对值**稳定在 3328**（hit% 只因分母
  变大从 98.0 缓降到 96.8）。

**结论**：失效的不是"改 system"这个**动作**，而是"**在前缀内部做非追加式修改**"。前缀缓存
是**纯位置**的：从第一个被改动的字节之后才失效。把新内容接到 system 末尾等价于尾部追加，
反而安全；只有把内容插到既有字节**中间**（后续整体前移）才会触发全前缀重建。
→ [`docs/runs/m1-cache.md`](runs/m1-cache.md) §1.4/§1.5、
[`docs/runs/m2-skills.md`](runs/m2-skills.md) §2 (c)/(c′)

---

## 3. MCP 是不是 eager？加/重排一个工具的真实代价 (M4)

**常见说法**：MCP 工具是惰性加载的，没调用的工具不占上下文；就算 eager，加一个工具也不过
是多花它那点描述 token。

**操作化问题**：固定 system + user，只改 `tools` 数组：(i) 注入 N 个 MCP 工具的
`prompt_tokens` 边际成本是多少、是否每轮都付？(ii) 往热集合**追加 1 个**工具、
或**只重排顺序**，`cached_tokens` 会掉多少？

**实测数字**：

| N | prompt | Δ vs N=0 | 边际 |
|---|---|---|---|
| 0 | 2842 | — | — |
| 1 | 3023 | **+181** | +181 / tool |
| 5 | 3675 | **+833** | ~163 / tool |
| 20 | 6142 | **+3300** | ~165 / tool |

- N=20 时 prompt 从 2842 → 6142，**+116%**，而这 20 个还都是短 description 的 echo 工具；
  这些 token **每轮请求都重新计费**（eager 全量注入），与是否调用无关。
- 往热集合追加 1 个 MCP 工具：prompt 只 **+169**（3376→3545），却把命中从 **3328** 打到
  **0（run A）/ 640（run B）**，一次丢掉 **2688–3328** token，是新增字节的 **~16–20 倍**；
  1 次相同请求即重新预热到 3456。
- 同一工具集**只重排顺序**（成员不变）：`cached` **3456 → 0**，内容一字未改。
- 确定性：把 `tools/list` 结果反转后再 `mcpToolsToSchemas()`，输出仍是 `echo_1, echo_2`。

**结论**：MCP **确实是 eager 的**——所有已连接 server 的工具元数据每轮全量注入。加/重排
一个工具不是"多花描述那点 token"，而是**从改动点起让整段工具前缀失效**，放大约 16–20 倍。
所以工具 schema 必须确定性排序，且**会话中途绝不动态增删 MCP 工具**。
→ [`docs/runs/m4-mcp.md`](runs/m4-mcp.md)

---

## 4. 压缩是否必然 miss？摘要放在哪 (M3)

**常见说法**：压缩只是省 token，压缩后的前缀照样能命中；把摘要固定在 system 之后最稳妥，
每次都从同一个位置开始。

**操作化问题**：压缩后第 1 次和第 2 次相同请求的 `cached` 各是多少？当共享头
`[system][brief]` **先被单独预热**时，摘要"**拼进历史**"（spliced）与"**钉在固定前导槽位**"
（leading）各能保住多少共享头？

**实测数字**：

- 压缩把 prompt 从 **30923 → 4814（−84.4%）**。
- 压缩后**第 1 次** `cached=0`（**必然付一次全量 re-warm**），**第 2 次**相同请求回到
  **4736/4814（98.4%）**；此后纯追加的 `follow` 稳定在 ~97.7–98.2%。
- 位置隔离探针（先把共享头预热到 4608/4659）：`splice#1` `cached=`**4608/4659（95.7%）**；
  `lead#1` `cached=`**512/4813（10.6%）**，**Δ=4096（共享头的 88.9%）**。
- 第二次压缩 `repack#1`：spliced **4608/4801（96.0%）** vs leading **3328/3615（92.1%）**。
- `clearToolResults(keepLastN=4)`：30922 → 15442（**−50.1%**），`clear#1` cached=0，
  `clear#2` **15360（99.5%）**，稳态 `follow` **15360（99.4%）**；本地统计
  `cleared=6, kept=4, charsSaved=53772, estTokSaved=13440`，transcript 校验 valid。

**结论**：压缩**必然付一次全量重预热**——"必然 miss"只在这一层成立（第 1 次 cached=0，
第 2 次回到 ~98%）。摘要**拼进历史**明确优于"固定前导槽位"：前者把摘要放在已缓存共享头
之后，前面的字节一字未动；后者插在 system 之后、brief 之前，把 brief 及其后全部前移，
实测差 **4096 token/压缩**。
→ [`docs/runs/m3-compaction.md`](runs/m3-compaction.md)

---

## 5. subagent 的成本模型：省的是谁 (M5)

**常见说法**：叫 subagent 就是省钱，总 token 一定会更少。

**操作化问题**：同一条调查任务（读 4 个源文件再总结）用 inline 与 delegated 两种方式执行，
**主上下文**最终 `prompt_tokens`、**全链路总 token / 成本**各是多少？

**实测数字**：

| run | parent final `prompt_tokens` | all-calls total | all-calls cost($) | calls |
|---|---|---|---|---|
| a-inline | **9420** | **10544** | 0.001190 | 2 |
| b-delegated | **858** | **12178** | 0.001414 | 4 |

- **主上下文节省**：9420 → 858，省 **8562 prompt_tokens（−90.9%）**。
- **全链路总 token**：10544 → 12178，delegation **多花 1634 token（+15.5%）**；
  成本 $0.001190 → $0.001414（**+18.8%**）。

**结论**：delegation 优化的**不是总 token，而是主上下文**。它把"一次性、可丢弃的工作噪音"
从长期存活的主消息数组里挪走，用一次性总 token 的小幅上升（+15%）换取主上下文的大幅缩小
（−91%）。当"工具原始输出 ≫ 子 agent 固定开销"时才划算；输出太小反而净亏。
→ [`docs/runs/m5-subagent.md`](runs/m5-subagent.md)

---

## 6. memory 的注入位置对缓存的影响 (M9)

**常见说法**：往上下文里加记忆、或记忆内容一变，就会炸缓存。

**操作化问题**：同一份渲染好的记忆块（437 chars、3 条），分别注入到 **system 前缀内部**
与 **消息数组尾部**（作为 `tool` result），预热后各连打 3 次相同请求，`cached` 各是多少？

**实测数字**：

| style | warm#2 `cached` | `inject#1` | `inject#2/3` | inject#1 cost($) |
|---|---|---|---|---|
| (a) prefix rewrite | 3648/3652（99.9%） | **0** | 3840/3855（99.6%） | 0.000541 |
| (b) tail injection | 3584/3697（96.9%） | **3584**（与预热逐字节相同） | 3840/3925（97.8%） | 0.000440 |

- 跨会话：会话 A 经 `memory` 工具存 3 条事实（A：prompt=1704, cached=0, $0.000264），
  一个**全新**的会话 B（另一个 `Agent`、空历史、只共享磁盘目录）调用 `memory search`
  答出 **"Blue Lantern"**（B：prompt=1372, cached=0, $0.000202）。
- `selftest` **7/7 passed**；本里程碑共 14 次 API 调用。

**结论**：**改记忆不必然炸缓存**，只取决于**注入位置**。放在尾部 tool result 时，预热前缀
3584 **逐字节不动**；插进 system 前缀内部则 3648 → **0**，需要再预热一次。检索结果一律
作为尾部 `tool` result 注入，绝不为了"把记忆放进上下文"改写 system。
→ [`docs/runs/m9-memory.md`](runs/m9-memory.md)

---

## 7. 排 25 个工具 vs 一个门面：lazy 省多少 (M11)

**常见说法**：工具多没关系，反正靠前缀缓存摊薄；`tool_search` 这种门面只是花架子。

**操作化问题**：N=25 个真实工具下，eager（25 份 schema）vs lazy（只注册 `tool_search` +
`tool_call` 两个 facade schema）：常驻前缀省多少 token？同一任务的总 token / 成本 / 调用数
怎样？对"实际拥有多少工具、按什么顺序注册"是否免疫？

**实测数字**：

| 指标 | eager | lazy |
|---|---|---|
| 常驻前缀（探针） | 4777 | **3100** |
| 前缀节省 | — | **−1677（−35.1%）** |
| 请求不变时峰值命中 | 4736/4777（**99.1%**） | 3040/3100（**98.1%**） |
| 任务 API 调用 | 2 | 3 |
| 任务 prompt 合计 | 4511 | **2574（−42.9%）** |
| 任务 total token | 4625 | **2714（−41.3%）** |
| 任务成本 | **$0.000310** | $0.000339 |

- 边际 ≈ **73 token/工具**（本次 fixture 描述较短；M4 用更长的 schema 实测 ≈165 token/工具）。
- 索引确定性：原序 vs 反转序，`entries()` 与 5 个 query 的 `search()` 结果逐字节相同，
  `determinism: PASS`；`index size: 25 tools`，`facade tools: tool_call, tool_search`。

**结论**：门面把常驻前缀压到 **−35.1%**，且对"拥有多少真实工具 / 注册顺序"**完全免疫**——
lazy 的常驻前缀只由 system + 两个固定 facade schema 组成，搜索命中的 schema 与工具输出都
追加在尾部。但它多一次搜索往返，N 小或任务短时成本可能略高（本次 +9%）；**工具多、单轮只用
少数、会话较长**时才划算。
→ [`docs/runs/m11-tool-search.md`](runs/m11-tool-search.md)

---

## 8. 编排：主上下文 vs 总 token 的取舍 (M10)

**常见说法**：多开 agent 并行做研究，一定更省 token。

**操作化问题**：3 个并行隔离 worker vs 单个 coordinator inline，coordinator 的**主上下文**
省多少、**全链路总 token / 成本**涨多少？任务太小时会怎样？

**实测数字**：

| run | coordinator final `prompt_tokens` | all-calls total | all-calls cost($) | calls |
|---|---|---|---|---|
| Run B inline | **8793** | **9829** | 0.001190 | 2 |
| Run B orchestrated | **1926** | **21970** | 0.002615 | 11 |
| Run A inline（小任务） | 1386 | 2378 | 0.000317 | 2 |
| Run A orchestrated（小任务） | **1907** | 14393 | 0.001623 | 11 |

- Run B（读大文件微任务）：coordinator 主上下文 **8793 → 1926（−78.1%）**；全链路 total
  **+123%**、成本 **+120%**。
- Run A（小任务反例）：原始输出只有几十 token，5 个编排工具 schema 的开销盖过收益，
  coordinator 主上下文 **1386 → 1907（+37.6%）**。
- 隔离证据：5 个 session id **互不相同**；每个 worker `own_messages=4`，coordinator 数组里
  只有 3 行摘要；`routed_messages=3`。Mailbox replay **7/7 PASS**（0 次 API）。

**结论**：编排与 subagent **同构**——省的是 coordinator 的**长期上下文**，不是总 token。
大任务下主上下文 −78.1%、总 token +123%；小任务下编排工具 schema 的开销盖过收益，主上下文
**不降反升（+37.6%）**。判据：**"省下的原始输出"必须大于"worker 固定开销 + 编排工具
schema"才值得下放。**
→ [`docs/runs/m10-orchestrator.md`](runs/m10-orchestrator.md)

---

## 9. 实现型里程碑没有缓存数字（如实标注：M6 / M7）

**常见说法**（隐含）：每个机制都应该能报出一组 `cached_tokens` 数字。

**操作化问题**：M6（权限/hooks/checkpoint）与 M7（后台/定时）到底测了什么？它们有没有
缓存数字？

**实测数字**：

- **M6**：**不调用任何模型 / API（0 次）**。决策表 8 个代表调用覆盖
  **allow / ask / deny / mutate / hook-deny** 五种结果；`preCompact` hook 注入
  "保留什么"指令；checkpoint 对文本、二进制 `0..255`、"快照时不存在、之后被创建"的文件
  做字节级还原，**12/12 断言 PASS**（用 sha256 判定，而非"写入没报错"）。
- **M7**：**0 次 API 调用**。一次性任务目标 1000ms，实测 **1018ms** 触发；
  `runInBackground` **+1ms** 返回、任务 **+721ms** settle（任务自身 `await 700ms`）；
  cancel 后 `runs=0`（函数从未执行）；interval 在 480ms 内触发 **2 次**、skipped=0；
  `drain()` 返回 **5** 条 outcome；**2** 条结果回灌为 session 消息；末尾
  `ALL CHECKS PASSED`。

**结论**：M6/M7 是**实现型里程碑**，如实标注：它们是纯函数 / `node:timers` + 字节断言，
**不含任何缓存 / token 实测数字**，因此不放进上面的"缓存结论"里。它们的可测量性体现为
**断言通过率**（12/12、ALL CHECKS PASSED）与真实墙钟数字，而不是 `cached_tokens`。
→ [`docs/runs/m6-permissions.md`](runs/m6-permissions.md)、
[`docs/runs/m7-scheduler.md`](runs/m7-scheduler.md)

---

## 这些结论怎么来的

所有数字都来自真实 OpenRouter 响应里的
`usage.prompt_tokens_details.cached_tokens` / `usage.prompt_tokens` / `usage.cost`，
每个里程碑用**独立实验脚本**在固定 `session_id`（sticky routing）、温度 0 下重复取样；
完整的方法、逐条 ledger 与复现命令见 `docs/MECHANISMS.md` §0–§7 以及各
`docs/runs/*.md`。三节课式的学习路径见 [`docs/LEARNING.md`](LEARNING.md)。
