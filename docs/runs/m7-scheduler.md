# 实验记录 — M7 后台与定时任务

**日期**：2026-10-03
**模型**：无（**0 次 API 调用**）——本机制是纯 `node:timers` + async，不需要模型。
**命令**：

```bash
# 无需 .env：脚本不 import loadConfig / OpenRouterClient
pnpm --filter @agent/server exec tsx scripts/scheduler-experiment.ts
```

**环境**：Node `v24.13.1`，`tsx` transpile-only，真实 timer。脚本用 `process.exitCode`
在任一断言失败时返回非零，所以这次运行是机器可判定的（末尾 `ALL CHECKS PASSED`）。

## 0. 方法

四个场景都用**真实时间**跑，并用硬断言（`>=` / `<` 阈值 + 状态检查）证明行为，而不是
只打印日志：

- **(a) 一次性任务**：`scheduleAfter(1000, fn)`；在注册后立刻打印一行证明调用方没被
  阻塞；`await handle.settled` 拿到 outcome；`reinjectTaskOutcome` 把结果变成一条
  session 消息。
- **(b) 后台任务**：`runInBackground(async () => { await 700ms; ... })`；记录返回时的
  墙钟耗时，证明 `runInBackground` 立即返回（任务尚未开始）；随后 `await handle.settled`
  取回结果并同样回灌。
- **(c) 取消**：`scheduleAfter(5000, () => { throw ... })`，立刻 `cancel()`；断言返回
  `true`、状态为 `cancelled`、`runs === 0`（函数从未执行）。
- **(d) 周期任务**：`scheduleInterval(200, fn)` 跑约 480ms 后取消；断言至少触发 2 次，
  并展示 `drain()` 里每个 tick 的 outcome。

## 1. 实测输出（关键片段，逐字）

```text
M7 scheduler-experiment — no model calls, real timers
node=v24.13.1

================ (a) scheduled one-shot fires after ~1000ms, result captured + re-injected ================
  registered after-musdzvgd-1; caller continues immediately (status=scheduled, fires in 1000ms)
  [subscribe] delayed-report -> succeeded (run 1)
  outcome: status=succeeded run=1 durationMs=0 result={"report":"daily digest","items":7,"firedAfterMs":1018}
  [PASS] (a) fired
  [PASS] (a) fired after ~1s — 1018ms
  re-injected session message:
    | [background task succeeded] id=after-musdzvgd-1 name="delayed-report" (one-shot, run 1, 0ms)
    |
    | Result:
    | { "report": "daily digest", "items": 7, "firedAfterMs": 1018 }
    |
    | This task ran outside the current turn. If the user is waiting on it, summarize the result now; otherwise fold it into your next reply.
  [PASS] (a) re-injected as a user message
  [PASS] (a) message carries the result
  proposed event: {"type":"task.settled","taskId":"after-musdzvgd-1","name":"delayed-report","kind":"one-shot","status":"succeeded","result":{...},"run":1,"at":1791031642871}

================ (b) runInBackground returns immediately; result collected later ================
  runInBackground returned at +1ms (status=scheduled, done=false)
  [PASS] (b) caller continued immediately — +1ms
  [PASS] (b) job is not done yet
  settled at +721ms: status=succeeded result={"computed":"index built","rows":1234} error=none
  [PASS] (b) completed while caller continued
  [PASS] (b) ran in the background
  [PASS] (b) captured the result
  re-injected session message:
    | [background task succeeded] id=bg-musdzw8o-3 name="heavy-job" (background, run 1, 708ms)
    | Result: { "computed": "index built", "rows": 1234 }
    | The background job finished; report the row count.
  [PASS] (b) re-injected

================ (c) cancel a pending task before it fires ================
  [subscribe] never-runs -> cancelled (run 0)
  cancel() -> true; outcome status=cancelled run=0
  [PASS] (c) cancel returned true
  [PASS] (c) settled as cancelled
  [PASS] (c) never ran — runs=0, state=cancelled
  [PASS] (c) state stays cancelled
  elapsed since scheduling: 156ms (would have fired at 5000ms)

================ (d) interval task fires repeatedly, then cancels ================
  [subscribe] heartbeat -> succeeded (run 1)
  [subscribe] heartbeat -> succeeded (run 2)
  after 489ms: runs=2 skipped=0 state=scheduled
  [subscribe] heartbeat -> cancelled (run 2)
  [PASS] (d) fired repeatedly — runs=2
  [PASS] (d) first outcome captured
  [PASS] (d) cancel returned true
  [PASS] (d) terminal state

================ drain() — pull every buffered outcome ================
  buffered: delayed-report status=succeeded run=1 result={"report":"daily digest","items":7,"firedAfterMs":1018}
  buffered: never-runs status=cancelled run=0 result=(no result)
  buffered: heartbeat status=succeeded run=1 result={"beat":224}
  buffered: heartbeat status=succeeded run=2 result={"beat":417}
  buffered: heartbeat status=cancelled run=2 result=(no result)
  [PASS] drain() returned the scheduled outcomes — 5 outcome(s)
  [PASS] drain() clears the buffer

================ session message array after re-injection ================
  2 message(s):
   - role=user "[background task succeeded] id=after-musdzvgd-1 name=\"delayed-report\" ..."
   - role=user "[background task succeeded] id=bg-musdzw8o-3 name=\"heavy-job\" ..."
  [PASS] two results re-injected as messages

registry size after shutdown: 3

ALL CHECKS PASSED
```

## 2. 数据要点

| 观测 | 值 | 说明 |
|---|---|---|
| (a) 任务实际触发延迟 | **1018ms**（目标 1000ms） | 真实 timer，误差在正常范围 |
| (a) 注册后调用方是否阻塞 | 否 | 注册后立刻打印，之后才 await |
| (b) `runInBackground` 返回耗时 | **+1ms** | 调用方同步代码先跑完（macrotask 语义） |
| (b) 后台任务结算耗时 | **+721ms** | 任务在调用方继续之后才完成 |
| (b) 任务耗时 | 708ms | `fn` 内部 `await 700ms` |
| (c) cancel 后 `runs` | **0** | pending 任务被取消，函数从未执行 |
| (c) 到取消的墙钟 | 156ms | 距原定 5000ms 触发点还早 |
| (d) 480ms 内 tick 次数 | **2** | 200ms 间隔，符合预期 |
| (d) skipped | 0 | 无重叠 tick |
| `drain()` 条数 | **5** | 2 个一次性 + 1 取消 + 2 次 interval tick |
| session 消息数 | **2** | 两条成功结果各回灌一条 |
| **API 调用** | **0** | 机制不需要模型 |

## 3. 结论（对照 `docs/MECHANISMS.md` §5）

§5 的钩子问题是：**“非阻塞执行如何不污染主 turn；定时触发的状态从哪读”**。

1. **非阻塞如何做到**：`runInBackground` 用 `setTimeout(start, 0)` 把 `fn` 推到下一个
   macrotask，handle 立即返回。实测调用方在 **+1ms** 就继续，而任务 **+721ms** 才完成；
   `Scheduler` 的 timer 回调也只 `void execute(...)`，从不 await 在注册路径上。于是主
   turn 的同步推进**完全不被打断**。
2. **如何不污染主 turn**：调度本身**不改 `AgentEvent` 流、不改循环**。任务只在被显式
   注入时才成为消息；注入是**尾部追加一条 `ChatMessage`**，不重写 system/历史前缀，
   因此不破坏 M1 的缓存前缀（append-only）。
3. **状态从哪读**：单任务 `handle.record()` / `handle.settled`；批量 `scheduler.drain()`
   （拉）；常驻观察者 `scheduler.subscribe()`（推）。outcome 是不可变的
   `{ status, result, error, run, startedAt, finishedAt, durationMs }`。
4. **取消**：pending 立即以 `cancelled` 结算、`run:0`、函数不执行；running 走
   `AbortController` best-effort。实测 `cancel() -> true` 且 `runs=0`。

**结果回灌与事件映射**：完成后结果发生在 turn 之外，不能作为 `role:"tool"` 在 turn 内
返回；因此回灌 = `messages.push(一条 user 消息)` + `store.saveMessages()`。同一次结算
的**事件形态**是 `{ type:"task.settled", taskId, name, kind, status, result?, error?, run, at }`
——与 `AgentEvent` 同形，加进 union 只需一行；M7 按约束**未编辑 `events.ts`**，只提供
`taskOutcomeToEvent()` 并走消息路径。

## 4. 约束遵守

- 只新增 4 个 Target 路径下的文件；**未修改** `packages/core/src/**` 任何已有文件
  （含 `events.ts`）、`packages/server/src/**`、`apps/web/**`、任何
  `package.json`/lockfile、`docs/CONTRACT.md`/`MECHANISMS.md`/`ROADMAP.md`。
- **未加依赖**：只用 `node:timers` + 已有 core 类型（`ChatMessage` 仅 `import type`）。
- **0 次模型调用**（预算 ≤5）。
- `.env` 仅在工作区本地复制（gitignored，未提交）；本脚本其实不需要它。
- `pnpm typecheck` 全包 green。

## 5. 代码位置

- 机制：`packages/core/src/mechanisms/scheduler/`
  - `types.ts` — `TaskOutcome` / `TaskRecord` / `TaskHandle` / 状态枚举
  - `background.ts` — `runInBackground` / `BackgroundHandle`
  - `scheduler.ts` — `Scheduler`（`scheduleAfter` / `scheduleAt` / `scheduleInterval`
    / `cancel` / `drain` / `subscribe` / `shutdown`）
  - `reinject.ts` — `taskOutcomeToMessage` / `reinjectTaskOutcome` / `taskOutcomeToEvent`
  - `ids.ts`, `index.ts`
- 实验：`packages/server/scripts/scheduler-experiment.ts`
- 教学文档：`docs/mechanisms/scheduler.md`

## 复现

```bash
pnpm install
pnpm --filter @agent/server exec tsx scripts/scheduler-experiment.ts   # 期望末尾 ALL CHECKS PASSED
pnpm typecheck
```
