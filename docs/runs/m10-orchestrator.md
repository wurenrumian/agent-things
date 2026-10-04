# 实验记录 — M10 orchestrator（supervisor + registry + 持久邮箱）

**日期**：2026-10-04
**模型**：`xiaomi/mimo-v2.6-flash`（OpenRouter）
**命令**：

```bash
pnpm --filter @agent/server exec tsx scripts/orchestrator-experiment.ts
# 分腿：... orchestrator-experiment.ts inline orchestrated
#       ... orchestrator-experiment.ts question
#       ... orchestrator-experiment.ts replay        # 0 次 API 调用
```

> 复现：worktree `m10-orchestrator` 里从主 worktree 复制 `.env`（gitignored，未提交），
> `pnpm install` 后执行上面的命令。脚本绕开 HTTP server，直接经 `OpenRouterClient`
> 打到 OpenRouter。出现 HTTP 429 时按 `3s / 6s / 9s` 退避重试整条腿。

**环境**：温度 0，`maxSteps=8`，`permissionMode=yolo`，模型名在脚本内固定为
`xiaomi/mimo-v2.6-flash`。本记录包含两次真实运行的数据：**Run B** 给出 token 账
（inline vs orchestrated，任务改为“读大文件、答一个词”以放大对比），**Run A** 给出
question/ack 与 replay 证据（这两条腿与任务文本改动无关，机制代码完全一致）。
单次完整运行约 **16 次** provider 调用，低于 ~30 次预算；均未触发 429。

> 说明：Run A（最早一次全量运行）用的是小任务（list_dir / 读小文件），它的 ledger
> 反而显示 orchestration 让 coordinator 上下文变大（1386 → 1907）——因为原始输出太小，
> 5 个编排工具的 schema 开销盖过了收益。这本身是个结论：**隔离只有在“原始输出 ≫
> 子 worker 固定开销”时才划算**。Run B 据此把任务换成读大文件，收益立刻出现。

## 1. 方法

三条独立微任务，每条都是「用工具读一个大文件 → 只回一个词的答案」：

| # | worker 名 | 任务（读文件 → 单词答案） | 期望答案 |
|---|---|---|---|
| 1 | `loop-maxsteps` | 读 `packages/core/src/agent/loop.ts`，答 `maxSteps` 的兜底整数 | `24` |
| 2 | `or-title-header` | 读 `packages/core/src/provider/openrouter.ts`，答由 `config.title` 设置的 HTTP header | `X-Title` |
| 3 | `sp-first-section` | 读 `packages/core/src/context/system-prompt.ts`，答 `buildSystemPrompt` 第一个 section 的 `name` | `identity` |

两种执行方式：

- **(a) inline**：一个 coordinator `Agent` 自己持 `builtinTools()`，用 `read_file`
  读这三个文件；每个 tool 结果（完整文件正文）都追加进它的消息数组。
- **(b) orchestrated**：coordinator `Agent` 只持 `createOrchestratorTools(supervisor)`，
  用 `spawn_worker` 并行起 3 个 worker，再用 `wait_for(["worker_done"])` 收 3 条
  **一行摘要**。worker 是全新 `Agent`（独立 session + 独立消息数组 + 内置工具 +
  `ask_coordinator`）。

每次调用读取真实 `usage`（`prompt_tokens` / `completion_tokens` /
`prompt_tokens_details.cached_tokens` / `cost`）。

## 2. token 账（Run B）

| run | coordinator final prompt_tokens | coordinator total | worker total | all-calls total | all-calls cost($) | calls |
|---|---|---|---|---|---|---|
| a-inline | **8793** | 9829 | — | **9829** | 0.001190 | 2 |
| b-orchestrated | **1926** | 8734 | 13236 | **21970** | 0.002615 | 11 |

- **coordinator 主上下文**：8793 → 1926，省 **6867 prompt_tokens（−78.1%）**。inline
  的 coordinator 把三份源文件正文（约 930 行）全吞进了自己的消息数组；orchestrated
  的 coordinator 只看到三行答案（`24` / `X-Title` / `identity`），加上 5 个编排工具的
  schema 与 6 次工具往返。
- **全链路总 token**：9829 → 21970，orchestration **多花 12141 token（+123%）**；
  成本 $0.001190 → $0.002615（**+120%**）。原因：3 个 worker 各自重建一份 system
  prompt + 工具 schema，并且每个文件被**读了两遍**（一次 inline、一次在 worker 里）。
- 两种方式的最终答案**完全一致**（三行都对），说明“只回灌最终文本”没有损失正确性。

> 关键洞见与 M5 一脉相承：**orchestration 优化的不是总 token，而是 coordinator 的
> 长期上下文。** 它把一次性、可丢弃的原始输出挪进 worker 的短命上下文，用一次性
> 总花费的上升换取主上下文的大幅缩小。coordinator 后续每多一个 turn，省下的 6867
> token 都会再省一次。

### 2.1 对比 Run A（小任务的反例）

| run | coordinator final prompt_tokens | all-calls total | all-calls cost($) | calls |
|---|---|---|---|---|
| a-inline（小任务） | 1386 | 2378 | 0.000317 | 2 |
| b-orchestrated（小任务） | 1907 | 14393 | 0.001623 | 11 |

小任务下原始输出只有几十 token，5 个编排工具的 schema（每个都带较长的 `description`
和 `parameters`）反而让 coordinator 的**每一步请求**都多付约 500 token，于是主上下文
不降反升（+37.6%）。判据：**“省下的原始输出” 必须大于 “worker 固定开销 +
编排工具 schema” 才值得下放。**

## 3. question / reply / ack 实录（Run A）

一个真实 worker 被明确要求：**第一个动作必须调用 `ask_coordinator`**。脚本作为
coordinator 用 `mailbox.wait(["question"], …)` **阻塞**等待（不是轮询），收到后
`reply`、`ack`。完整转录：

```text
================ (c) question / reply / ack ================
  question received while worker status=blocked
worker: worker-mutetilf-7
Q id=msg-mutetjhi-8: "Which word should I use as my final answer: ALPHA or BETA?"
A: "Use the single word BETA."
worker final answer: "BETA"
worker final status: done
status transitions:
  (new) -> starting
  starting -> running (spawned)
  running -> blocked (awaiting coordinator reply)
  blocked -> running (coordinator replied)
  running -> done (worker finished)
```

要点：

1. worker 的 `ask_coordinator` 工具先 `mailbox.send({type:"question"})`，再把自己在
   registry 里置为 `blocked`，然后 `await mailbox.wait(["reply"], …, {to:workerId})`。
   它**真的挂起**，不是空转。
2. coordinator `wait(["question"])` 在 question 到达前一直阻塞；到达即被唤醒。
3. coordinator `send` 一条 `reply` 后，worker 的 `wait` 立即 resolve，工具 `ack` 掉
   这条 reply，worker 继续跑完，最终 `status=done`、答案是 `BETA`。
4. registry 的 `transitions` 完整记录了 `blocked → running` 的恢复点——这就是
   “worker 卡住时可观测”的体现（而不是对着黑盒终端猜）。

## 4. 未 ack 投递的重放证明（Run A，纯 Mailbox，0 次 API 调用）

```text
================ (d) mailbox replay / durability ================
sent=[msg-mutetkj3-b, msg-mutetkj3-c] first=msg-mutetkj3-b replay=msg-mutetkj3-b afterAck=msg-mutetkj3-c
wait=msg-mutetkj3-d waitReplay=msg-mutetkj3-d pending=1
  [PASS] unacked delivery is replayed — first=msg-mutetkj3-b replay=msg-mutetkj3-b q1=msg-mutetkj3-b
  [PASS] oldest-first FIFO with a filter — msg-mutetkj3-b from w1
  [PASS] ack advances the queue to the next message — afterAck=msg-mutetkj3-c q2=msg-mutetkj3-c
  [PASS] pending() reflects only the unacked tail — 1 pending
  [PASS] wait() replays an unacked message too — waited=msg-mutetkj3-d replay=msg-mutetkj3-d
  [PASS] acked message stops replaying — null
  [PASS] mailbox survives a reload (durable ops log) — 2 message(s), 1 pending
```

- `q1 = msg-…-b`、`q2 = msg-…-c` 两条 question。`deliverNext` 先给 `q1`；**不 ack**
  再 `deliverNext`，返回的**还是 `q1`**（重放）。`ack(q1)` 之后，下一次才前进到 `q2`。
- `wait()` 遵守同一条规则：一条未 ack 的 `note` 会被下一次 `wait()` 再次拿到。
- 最后一条：`ack` 过的消息不再重放，`wait(..., 0)` 立刻返回 `null`。
- **持久化**：用 `file:` 构造的 Mailbox 把 `send`/`ack` 追加进 JSONL ops log；重新
  `new Mailbox({file})` 后 `acked` 状态与 `pending()` 完全恢复。这就是“durable”。

## 5. 隔离性证据（Run B）

```text
=== ISOLATION ===
session ids (5): m10-inline-muteu710, m10-orch-coord-muteu9gv,
                 worker-muteuags-1, worker-muteuagz-2, worker-muteuah3-3
distinct session ids: true
inline coordinator context: 6 messages; orchestrated coordinator context: 12 messages
worker worker-muteuags-1: text="24"       steps=2 tool_calls=1 own_messages=4
worker worker-muteuagz-2: text="X-Title"  steps=2 tool_calls=1 own_messages=4
worker worker-muteuah3-3: text="identity" steps=2 tool_calls=1 own_messages=4
routed coordinator messages: 3
```

- 5 个 session id **互不相同**：coordinator 与 3 个 worker 各有独立消息数组；provider
  各自 sticky-route，前缀缓存各算各的。
- 每个 worker 的上下文里都有 4 条消息（user + assistant(tool_call) + tool + assistant
  answer），而 coordinator 的数组里**只有一行摘要**，没有那份 400 行文件正文——这就是
  “无跨上下文泄漏”。
- `routed_messages=3`：supervisor 的 `onMessage` 恰好被 3 条 `worker_done` 触发。

## 6. 回答 brief 的三个问题

1. **N 个并发隔离 worker vs inline 的 token/缓存差异。** 见 §2：coordinator 主上下文
   **−78.1%**（8793 → 1926）；全链路 token **+123%**、成本 **+120%**（重复读文件 +
   重复 system prompt/tool schema）。小任务下（§2.1）隔离甚至让主上下文变大——收益
   取决于“原始输出 ÷ 固定开销”。
2. **为什么需要 `wait` + `ack`（FIFO 重放），而不是轮询。** 轮询要么需要反复扫一个
   共享状态（有竞态、空转烧 CPU），要么只能去解析终端输出（本机制拒绝）。`wait` 给
   的是**事件驱动阻塞**：消息一到立刻唤醒，没有消息就不占 CPU。`ack` 是**消费游标**：
   投递本身不消费，只有 `ack` 才把消息移除，所以未 ack 的消息会在下一次投递时**重放**
   ——这是 at-least-once 投递，专为“消费者读完就崩”设计（Orca 的 `--ack` 同义）。
   没有 ack，一条 question/worker_done 会被 coordinator 反复拿到死循环。
3. **为什么不需要 PTY/终端模拟器，PTY 适配器又何时才需要。** worker 就是进程内的
   `Agent`（自有 session 与消息数组），协调走**结构化 mailbox + registry**，事件走
   `AgentEvent` 流；没有任何地方去“启动一个 TTY 进程并解析它的字符输出”。PTY 适配器
   只在要驱动**外部黑盒 TTY agent**（只会在 pty 上吐 ANSI、没有结构化事件/消息接口的
   CLI）时才需要——那是可选适配层，不是本机制。

## 7. 约束遵守

- 只新增 4 个 Target 路径下的文件（`packages/core/src/mechanisms/orchestrator/**`、
  `packages/server/scripts/orchestrator-experiment.ts`、本文件、
  `docs/mechanisms/orchestrator.md`）；**未修改**任何已有共享文件、`package.json`、
  `pnpm-lock.yaml`、`docs/CONTRACT.md` / `MECHANISMS.md` / `ROADMAP.md` / `docs/briefs/**`。
- **未加依赖**：邮箱持久化 / id / 轮询全部用 Node 内置 + 已有 core 代码手写。
- **无 PTY**：不 import `node:child_process` 的 pty，不解析终端输出。
- `.env` 仅工作区本地复制，`.gitignore` 覆盖，未提交。
- `pnpm typecheck`（core/server/web/cli）全绿。
- 单次完整运行约 16 次 provider 调用（预算 ~30）；实现了 429 退避重试。

## 8. 复现

```bash
cp D:/Project/agent-things/.env ./.env      # gitignored
pnpm install
pnpm --filter @agent/server exec tsx scripts/orchestrator-experiment.ts
# 分腿：... orchestrator-experiment.ts inline orchestrated
#       ... orchestrator-experiment.ts question
#       ... orchestrator-experiment.ts replay
pnpm typecheck
```

代码位置：

- 机制：`packages/core/src/mechanisms/orchestrator/`
  （`registry.ts` / `mailbox.ts` / `supervisor.ts` / `tools.ts` / `types.ts` / `index.ts`）
- 实验：`packages/server/scripts/orchestrator-experiment.ts`
- 教学文档：`docs/mechanisms/orchestrator.md`
