# 机制：orchestrator（supervisor + registry + 持久邮箱）

> 实测数据见 [`../runs/m10-orchestrator.md`](../runs/m10-orchestrator.md)。
> 代码：`packages/core/src/mechanisms/orchestrator/`。
> 对照 `docs/STATE.md` §7：Orca 自己如何派发 / 等待 / ack / 收 worker。

## 1. 一句话

**orchestrator = 把“多个 worker 并行干活 + 互相通信”做成进程内的结构化事件流：一个
worker 就是一个 `Agent`（独立 session、独立消息数组），协调靠一份可查询的
`WorkerRegistry` 和一条持久、FIFO、需 ack 的 `Mailbox`，由 `Supervisor` 统一驱动。**

它回答的问题是：**不启动终端、不解析 TTY 输出，能不能复刻 Orca 的多 agent 协调？**
能。因为在本项目里 worker 不是“黑盒 CLI 进程”，而是可以被我们直接观察 `AgentEvent`
的 `Agent`。Orca 之所以需要终端模拟器，是因为它驱动的是不透明的 TTY 二进制；这里
没有这个约束。

## 2. 为什么需要它

M5 的 subagent 已经能“父 agent 派一个子 agent 跑完拿回摘要”，但它是**同步、一对一**
的：父 `await` 子，子不能反问，父子之间没有通道。真正的编排还需要三件 subagent 没
有的东西：

1. **并行与登记**：同时起 N 个 worker，并随时知道谁在 `starting/running/blocked/
   done/failed`——这就是 `WorkerRegistry`。
2. **双向通信**：worker 卡在一个只有 coordinator 能拍板的问题上时，要能“发问并挂起”，
   coordinator 回答后继续——这就是 `Mailbox`（question / reply / escalation /
   worker_done / note）。
3. **统一生命周期**：谁来起、谁来收、谁能取消、把 worker 的消息转给谁——这就是
   `Supervisor`。

再往上一层，parent `Agent` 不该手写这些逻辑，而应该像 Orca 的 coordinator 一样，
用**工具**（`spawn_worker` / `wait_for` / `send_message` / `list_workers` /
`stop_worker`）来编排。这就是 `createOrchestratorTools`。

## 3. 数据流

```
            createOrchestratorTools(supervisor)
   coordinator Agent ──spawn_worker──▶ Supervisor ──factory──▶ worker Agent #1 (session A)
        ▲   │                          │      │                 worker Agent #2 (session B)
        │   └──wait_for / send_message─┘      │                 worker Agent #N (session C)
        │                                      ▼
        │                             WorkerRegistry  (状态 + transitions)
        └────────── AgentEvent / mailbox 消息 ─────┘
                                       │
                                       ▼
                              Mailbox (durable, FIFO, ack/replay)
```

- worker 的最终文本 → `Supervisor` 记进 `WorkerReport`，并作为一条 **`worker_done`**
  消息投进 mailbox；coordinator 用 `wait_for(["worker_done"])` 取。
- worker 的 `ask_coordinator` → mailbox 里一条 **`question`**；coordinator `wait` 到后
  `reply` + `ack`，worker 的 `wait` resolve，继续跑。
- 全程没有任何终端解析；观测面就是 registry 快照 + mailbox 转录 + `AgentEvent`。

## 4. 三个部件

### 4.1 `WorkerRegistry` — 谁存在、在什么状态

```ts
const registry = new WorkerRegistry();
const rec = registry.add({ name: "alpha", task: "…" });   // status: "starting"
registry.update(rec.id, { status: "running" }, "spawned");
registry.get(rec.id);        // 快照（克隆）
registry.list();             // 全部快照
registry.snapshot();         // 同 list()
registry.remove(rec.id);     // 删除
```

`WorkerRecord` 的字段是**冻结接口**（后续 INT 波次按此接入）：

```ts
{
  id, name, task,
  status: "starting" | "running" | "blocked" | "done" | "failed",
  sessionId?, result?, error?,
  startedAt, endedAt?,
  transitions: { from?, to, at, reason? }[]   // 追加式状态迁移日志
}
```

任何一次 `status` 变化都会追加一条 `transitions`，所以实验里能打出
`starting → running → blocked → running → done` 的完整轨迹。`get/list/snapshot`
返回**克隆**，外部改不动内部记录。

### 4.2 `Mailbox` — 持久、FIFO、需 ack 的队列

一条消息：

```ts
{
  id, from, to,
  type: "question" | "reply" | "escalation" | "worker_done" | "note",
  subject?, body, at, acked,
  deliveries?, deliveredAt?        // 观测：被投递过几次 / 最后一次
}
```

API：

| 方法 | 语义 |
|---|---|
| `send(msg)` | 入队；唤醒等待中的 `wait`；触发 `subscribe`/`onSend` |
| `deliverNext(types?, filter?)` | 取**最老的、未 ack、匹配**的一条；**不消费** |
| `ack(id)` | 消费一条；之后不再重放。返回是否真的消费了 |
| `pending(types?, filter?)` | 所有未 ack 的匹配消息 |
| `wait(types?, timeoutMs?, filter?)` | 异步阻塞到有匹配消息可投递；超时返回 `null` |
| `size()` / `all()` / `get(id)` | 观测 / 转录 |
| `subscribe(fn)` | 每次 `send` 回调，返回 unsubscribe |
| `compact()` / `dispose()` | 压缩持久日志 / 丢弃等待者 |

**核心教学点：投递 ≠ 消费。** `deliverNext`/`wait` 把消息交给消费者，但不改 `acked`；
只有 `ack` 会消费。于是**未 ack 的投递会在下一次投递时重放**——这正是 Orca 每条
`check` 都要 `--ack` 的原因。它给的是 **at-least-once 投递**：消费者读完消息就崩，
下次还能再拿到。若没有 ack，一条 question / worker_done 会被反复投递。

`filter` 支持 `{ to?, from? }`，所以“等某个 worker 的回复”就是
`wait(["reply"], 30000, { to: workerId })`。

**durable**：用 `new Mailbox({ file })` 时，`send`/`ack` 各追加一行 JSONL
（`{op:"send",…}` / `{op:"ack",…}`），构造时 fold 回内存。进程重启后 `acked` 状态与
`pending()` 完整恢复。不传 `file` 则是纯内存（默认）。没有引入任何依赖。

### 4.3 `Supervisor` — 并行起、统一收、消息路由

```ts
const supervisor = new Supervisor({
  client, model, cwd,
  coordinatorId: "coordinator",       // 默认
  maxSteps: 8, temperature: 0,
  onMessage: (m) => { /* 路由给 coordinator 的消息 */ },
  mailboxFile: "…/mailbox.jsonl",     // 可选：持久邮箱
});

const rec = supervisor.spawn({ name: "alpha", task: "…" });   // 立即返回
const recs = supervisor.spawnAll([specA, specB, specC]);      // 并行
await supervisor.waitForAll(120_000);                         // 等全部结束
supervisor.report(rec.id);   // { text, usages, summary, steps, toolCalls, messageCount }
supervisor.reports();        // 全部
supervisor.usage();          // 聚合 token/cost
supervisor.reply(rec.id, "use BETA");   // 回答某个 worker 的 question
supervisor.waitFor(["worker_done"], 60_000);
supervisor.stop(rec.id);                 // 取消一个
await supervisor.stopAll();              // 取消全部
supervisor.dispose();
```

**注入的 `AgentFactory`** 是唯一的“怎么造 worker”接口：

```ts
type AgentFactory = (spec: ResolvedWorkerSpec, ctx: WorkerContext) => WorkerAgent;
```

默认 `defaultAgentFactory` 镜像 `mechanisms/subagent`：为每个 worker 起一个全新
`Agent`，工具集 = `builtinTools()` + `ask_coordinator`（**刻意没有 `task`**，worker
不再往下派），system prompt 用 `WORKER_SYSTEM_PROMPT`（强调“只回最终文本、要简洁”）。
worker 的 session id 就是它的 worker id，所以 provider 前缀缓存各算各的。

**blocked 语义**：worker 调 `ask_coordinator` 时，工具先 `mailbox.send(question)`，
把 registry 状态置 `blocked`，再 `await mailbox.wait(["reply"], …, {to:workerId})`；
reply 到达后置回 `running` 并 `ack` 掉 reply。整个过程对 coordinator 完全可观——
registry 里能直接看到谁 `blocked`、以及 `transitions` 里的恢复点。

`Supervisor` 在构造时 `mailbox.subscribe(...)`，把 `to === coordinatorId` 的消息转给
`onMessage`；每个 worker 结束时再自动 `send` 一条 `worker_done`（失败也发，body 带
错误），所以 `wait_for(["worker_done"])` 永远不会因为某个 worker 崩了而挂死。

### 4.4 `createOrchestratorTools(supervisor)` — 给 parent Agent 的编排词汇

返回 5 个 `ToolDef`（不碰内核，循环本来就会调工具）：

| 工具 | 作用 |
|---|---|
| `spawn_worker` | 起一个隔离 worker，立即返回 id |
| `wait_for` | 阻塞等 coordinator 的消息（可按 `types`/`from` 过滤），默认取到即 `ack` |
| `send_message` | coordinator → worker 发 `reply`/`escalation`/`note`（`to:"*"` 广播） |
| `list_workers` | registry 快照（状态、session、结果预览） |
| `stop_worker` | 取消一个 worker |

`wait_for` 保留了 `ack=false` 开关，用来直接演示“未 ack ⇒ 重放”。parent Agent 用它
编排时，自己的上下文里只会出现一行行摘要——这正是 §2 里 coordinator 主上下文大幅
缩小的原因。

## 5. 为什么不需要 PTY / 终端模拟器

Orca 现实中要 pty + `terminal read/wait`，是因为它协调的是**外部黑盒 TTY 进程**：
只能把字节写进伪终端、再从字节流里猜它在 `blocked` 还是 `done`。本项目的 worker 不是
黑盒——它是一个我们能拿到 `AgentEvent` 流的 `Agent`，有自己的消息数组。协调因此可以
升级成结构化接口：

| 协调需求 | Orca（TTY） | 本机制（事件流） |
|---|---|---|
| 派发 | 往 pty 写文本 | `spawn_worker` / `Supervisor.spawn` |
| 存活/状态 | `terminal read` 猜 | `WorkerRegistry` 明确状态 + transitions |
| 等待 | 轮询 terminal | `Mailbox.wait` 事件驱动阻塞 |
| 消息 | 终端里的字符 | `MailboxMessage` {type, from, to, body} |
| 消费确认 | `check --ack` | `Mailbox.ack`（未 ack 重放） |

**PTY 适配器什么时候才需要？** 只有当 worker 是**我们无法改造成 Agent 的外部程序**、
只提供交互式 TTY（例如某个只会在 pty 上吐 ANSI 的第三方 CLI），且没有结构化事件/消息
接口时，才需要一层 pty adapter 把它的输入输出桥接成 mailbox 消息。那是**可选的适配
层**，不是本机制的内核。本机制证明了核心协调逻辑与传输方式无关。

## 6. 边界与后续

- **持久化的范围**：邮箱可落盘（ops log）。registry 与 worker 的消息数组仍是内存的，
  进程重启即丢——跨重启恢复 worker 状态属于后续工作。
- **不做 PTY**：见 §5。
- **并发**：`spawn` 不做并发上限；`waitForAll` 支持超时；`stopAll` 协作式取消
  （`AbortController`，worker 若观察 signal 就能提前收尾）。
- **接入 server/web**：是合并后的独立 INT 波次；本目录自包含、只走相对 import，接入
  是机械的（`new Supervisor(...)` + 注册 `createOrchestratorTools`）。需要在
  `events.ts` 加 `worker.*` 事件的话也只加一个 union 成员，机制本身不依赖它。
- **模型调用**：机制本体不需要模型；实验调真实模型，单次全量约 16 次调用。

## 7. 复现

```bash
pnpm --filter @agent/server exec tsx scripts/orchestrator-experiment.ts
pnpm --filter @agent/server exec tsx scripts/orchestrator-experiment.ts replay   # 0 次调用
pnpm typecheck
```

实测：coordinator 主上下文 **8793 → 1926（−78.1%）**，全链路 token +123%（隔离的代价）。
详见 [`../runs/m10-orchestrator.md`](../runs/m10-orchestrator.md)。
