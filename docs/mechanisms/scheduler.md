# 机制：scheduler（后台与定时任务）

> 实测数据见 [`../runs/m7-scheduler.md`](../runs/m7-scheduler.md)。
> 代码：`packages/core/src/mechanisms/scheduler/`。
> 对照 `docs/MECHANISMS.md` §5：**“非阻塞执行如何不污染主 turn；定时触发的状态从哪读”**。

## 1. 一句话

**scheduler = 把“现在不该做、或做得慢”的工作从主 turn 里挪到事件循环上，用一份
可查询的状态记录 `{ status, result, error }` 代替“等待”，再把完成结果作为一条尾部
消息回灌进会话消息数组。** 主 turn 因此立即继续，长任务在后台跑，结果晚到但可追。

回到 §0 的心智模型：agent 的能力是“在正确时机把正确字符放进消息数组”。subagent
（M5）回答的是“**放多少**”——把一次性工作整段隔离；scheduler 回答的是“**何时**”——
把工作**推迟到当前 turn 之外**执行，完成后再决定要不要放回消息数组。

## 2. 为什么需要它

主 agent 的 `run()` 是一个同步推进的 async generator：一个 turn 里，模型每发一个
工具调用，循环就 `await execute()`，然后带着 tool result 再问模型。这里有两个撞墙点：

1. **长任务会阻塞 turn**。如果工具函数要跑 30 秒（构建、全仓扫描、等外部服务），
   整个 turn 就卡 30 秒：模型没有新输入，用户看不到进度，也没法取消。
2. **“以后再做”无处安放**。定时任务（“5 分钟后重试”“每天 9 点总结”）根本不属于
   任何一次同步 `await`；它的结果到达时，往往**已经不在任何一个 turn 里**了。

scheduler 的两个部件分别对应这两点：`runInBackground(fn)` 解决“慢”，`Scheduler` 解决
“以后 / 反复”。第三个部件 `reinject` 解决“结果怎么回到模型看得见的地方”。

```
                 register / runInBackground
   turn ──────────────▶ Scheduler / background handle   （立即返回，turn 继续）
     │                          │
     │  caller continues        │  setTimeout / setInterval（事件循环）
     ▼                          ▼
   ...下一行...             fn() 执行 → 捕获 { status, result, error }
                                │
                      drain() / subscribe() / handle.settled
                                │
                      reinjectTaskOutcome(messages, outcome)
                                ▼
                      messages.push(一条 user 消息) → 下个 turn 模型能看到
```

## 3. 三个部件

### 3.1 `runInBackground(fn)` — 一个 handle + 一个 settled promise

`runInBackground` 只做一件事：**立刻返回**，把 `fn` 推到下一个 macrotask 去跑。

```ts
const job = runInBackground(async () => { await work(); return rows; });
//  ← 到这里 fn 还没开始；调用方的同步代码继续
console.log(job.status());      // "scheduled"
const outcome = await job.settled; // { status:"succeeded", result: rows, ... }
```

关键实现细节：用 `node:timers` 的 `setTimeout(start, 0)` 而不是 `queueMicrotask`。
macrotask 保证**调用方在 `await` 之前的所有同步代码**（以及同一轮微任务）都先跑完
——实验里 `runInBackground` 返回后第一行 `console.log` 的耗时是 **+1ms**，而任务本身
721ms 后才 settled。这就是“非阻塞”的可观测定义。

它返回的 `BackgroundHandle` 是 `run_in_background` 工具需要的形状：

| 成员 | 用途 |
|---|---|
| `status()` | 查询 `scheduled / running / succeeded / failed / cancelled` |
| `result()` / `error()` | 取当前结果/错误（未完成时 `undefined`） |
| `isDone()` | 是否已终结 |
| `cancel()` | best-effort 取消（abort signal + 立即以 `cancelled` 结算） |
| `settled` | 永不 reject 的 promise；失败也以 `status:"failed"` 结算 |

**永不 reject** 是刻意的：后台任务不该用未处理的 rejection 炸掉调用方。错误被
捕获成 outcome 的 `error` 字段，和普通结果走同一条路。

### 3.2 `Scheduler` — 一次性 / 定时 / 周期

```ts
const scheduler = new Scheduler();

scheduler.scheduleAfter(1000, () => digest(), { name: "delayed-report" });
scheduler.scheduleAt(new Date("2026-10-04T09:00:00"), () => morning());
const beat = scheduler.scheduleInterval(200, () => ping(), { name: "heartbeat" });
```

- **一次性**：`scheduleAfter(delayMs, fn)` / `scheduleAt(when, fn)`。
- **周期**：`scheduleInterval(intervalMs, fn)`，首次在一整个 interval 之后触发。
- 每个任务都有 `TaskRecord`（`handle.record()` / `scheduler.get(id)`），字段包括
  `state`、`runs`、`lastStatus`、`result`、`error`、`nextRunAt`、`skipped`。
- 每次执行内部都走 `runInBackground`，所以调度器自身也不会阻塞：timer 回调只负责
  `void this.execute(...)`。

**周期任务不排队：** 如果上一次还没跑完，这一次 tick 直接**跳过**并把
`record.skipped += 1`，而不是堆积 promise。慢任务因此不会把内存撑爆——这是周期
调度最容易踩的坑。

### 3.3 `reinject` — 结果回到消息数组

```ts
const messages = store.getMessages(sessionId);   // ChatMessage[]
reinjectTaskOutcome(messages, outcome);          // push 一条消息
store.saveMessages(sessionId, messages);
```

完成后任务的结果**不是**通过工具返回值回灌的——它发生在 turn 之外，没有正在进行的
`execute()` 可以接收它。回灌的最小正确形式就是**往会话消息数组尾部追加一条消息**：

```
[background task succeeded] id=after-… name="delayed-report" (one-shot, run 1, 0ms)

Result:
{ "report": "daily digest", "items": 7, "firedAfterMs": 1018 }

This task ran outside the current turn. If the user is waiting on it, summarize …
```

默认注入为 `role:"user"`（`opts.role:"system"` 可改成系统提醒），结果文本按
`maxResultChars`（默认 4000）截断。**追加到尾部**，而不是改写 system 或历史前缀，
所以它不会破坏已缓存的前缀——这正是 M1/M2 的 append-only 结论在 scheduler 上的复用。

### 3.4 事件映射（不改 `events.ts`）

`TaskOutcome` 描述的是“一次执行结束了”。它天然对应一个事件：

```ts
// 提议形态（reinject.ts 里的 ProposedTaskSettledEvent）
{ type: "task.settled", taskId, name, kind, status, result?, error?, run, at }
```

它和 `AgentEvent` 现有成员同形（`{ type, ..., at }`），**加进 `packages/core/src/
events.ts` 的 union 只需一行**。但 M7 的铁律是**不得编辑 `events.ts`**，所以本机制：

- 不 import、不改 `events.ts`；
- 提供 `taskOutcomeToEvent()` 生成该事件对象，供集成方使用；
- 真正的回灌走 **`ChatMessage` 路径**（上一节），**完全不依赖 `events.ts`**。

集成时的两种接法（合并后由协调者做）：

1. **消息路径（本机制已可用）**：`task.settled` 到达 → `reinjectTaskOutcome()` 追加
   消息 → `store.saveMessages()`。观测台只看到 messages 变了，events 不变。
2. **事件路径（需一行 union 改动）**：把 `task.settled` 加进 `AgentEvent`，server
   `appendEvents()` 持久化它，web 渲染一张卡片；同时仍要执行第 1 步，模型才看得到。

## 4. 定时触发的状态从哪读

这是 §5 的直接答案。状态有**三个读法**，对应三种消费者：

| 消费者 | 接口 | 语义 |
|---|---|---|
| 工具/调用方关心某一个任务 | `handle.status()` / `handle.record()` / `handle.settled` | 单任务快照 + 首次结算 |
| 调度器外部批量收割 | `scheduler.drain()` | **拉**：取走自上次 drain 以来的所有 outcome |
| 常驻观察者（观测台 / 日志） | `scheduler.subscribe(fn)` | **推**：每个 outcome 实时回调，返回 unsubscribe |

- `settled` 只 resolve **一次**（一次性任务的那次运行、周期任务的第一次 tick、或取消）
  ——它是“等这一个任务有结果”的最简用法。
- 周期任务会持续产生 outcome；要拿全量就用 `drain()` / `subscribe()`。
- `TaskOutcome` 是不可变记录：`{ taskId, name, kind, status, result?, error?, run,
  startedAt, finishedAt, durationMs }`。`run` 为 0 表示“取消发生在第一次运行之前”。
- 可选的 `onOutcome` 构造项与 `drain` 并存：前者给即时推送，后者给拉取式消费，互不
  干扰（实验里 `subscribe` 打出了每个 outcome，最后 `drain` 仍拿到了全部 5 条）。

状态是**内存中**的，进程重启即丢。这是刻意的：M7 关注的是“调度与回灌”这一机制，
持久化（定时队列落盘、跨重启恢复）属于后续工作。

## 5. 取消语义

```ts
const h = scheduler.scheduleAfter(5000, fn);
h.cancel();      // → true（之前是 active）；outcome.status === "cancelled"，run === 0
```

- **pending**（还没到点）：清掉 timer，立即以 `cancelled` 结算，`run:0`，`fn` 永不执行。
- **running**：`AbortController.abort()` + 立即以 `cancelled` 结算；长任务若观察
  `signal` 就能提前收尾。这是 **best-effort**——纯同步且不看 signal 的 `fn` 无法被
  强杀，但它的结果会被忽略、也不会二次结算（`finished` 守卫）。
- 已终结（`succeeded/failed/cancelled`）的任务再 `cancel()` 返回 `false`。
- 注册时传入 `opts.signal`，外部 abort 会自动取消该任务。

`shutdown()` 会清掉所有 timer、取消所有 active 任务，并 `await` 所有在飞行中的执行，
所以 demo 脚本能干净退出。

## 6. 边界与后续

- **不污染主 turn 的含义**：scheduler 本身不向 `AgentEvent` 流写入任何东西，也不改
  循环。它只在“有人调用”时调度，并把结果变成一个待注入的消息；注入与否、何时注入，
  由会话层决定。主 turn 的 `prompt_tokens` 只在消息真的被注入后才增大。
- **未做**：时间的持久化与跨重启恢复；分布式/多进程调度；任务优先级与并发上限
  （当前 interval 用 skip 防堆积，一次性任务则按注册即调度）；结果的结构化 schema
  校验。接进 HTTP server / 观测台是合并后的独立一步。
- **模型调用**：本机制不需要模型，实验 **0 次** API 调用。

## 7. 复现

```bash
pnpm --filter @agent/server exec tsx scripts/scheduler-experiment.ts   # 无需 .env
pnpm typecheck
```
