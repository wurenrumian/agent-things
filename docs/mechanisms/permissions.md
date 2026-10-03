# 机制：权限、Hooks 与 Checkpoint（M6）

> 对应 MECHANISMS 的 **L4 hooks**、**L6 checkpoint**、**L7 权限**。实现位于
> `packages/core/src/mechanisms/hooks/` 与 `mechanisms/checkpoint/`，演示脚本为
> [`../../packages/server/scripts/hooks-experiment.ts`](../../packages/server/scripts/hooks-experiment.ts)，
> 实验数据见 [`../runs/m6-permissions.md`](../runs/m6-permissions.md)。
> 本里程碑**不调用任何模型/API**。

## 1. 一句话

工具执行前，代码要在**一个明确的缝**上回答三个问题：**允不允许**（权限策略）、
**要不要先改一下输入、或注入点什么**（hooks）、**改之前有没有留退路**（checkpoint）。
M6 把这三件事各做成一个自包含机制，再用一个 `decide()` 把它们拼成一个裁决。

## 2. 三个机制的分工

| 机制 | 回答的问题 | 决策粒度 | 能否改写输入 |
|---|---|---|---|
| **权限策略** `Policy` | 这个工具调用是 `allow / ask / deny`？ | 规则（首个命中胜出） | 否 |
| **Hooks** `HookRunner` | 生命周期点上要拦截/注入/改写什么？ | 事件 + 工具名/regex | **是**（mutate） |
| **Checkpoint** `CheckpointStore` | 这一轮改了文件，怎么字节级回退？ | 文件 × turn | 否（但保存字节） |

关键区分：**权限裁决「能不能做」，hook 裁决「怎么做」**。一个 hook 可以改写一次
`run_shell` 的命令（如剥掉 `sudo`），却把最终 allow/deny 留给规则层——这正是
`decide()` 把两者组合起来的意义。

## 3. Hook 系统（`mechanisms/hooks/`）

四个生命周期点：

| 事件 | 时机 | 主体 | 典型用途 |
|---|---|---|---|
| `preToolUse` | 工具执行前 | tool + input | 拦截危险命令、改写参数 |
| `postToolUse` | 工具返回后 | tool + input | 审计、脱敏（观察式） |
| `preCompact` | 历史被压缩前 | text | 注入「压缩时保留什么」的指令 |
| `userPromptSubmit` | 用户提示进入模型前 | text | 加标记、改写提示 |

一个 hook 返回四种结果之一：

```ts
type HookOutcome =
  | { kind: "allow"; reason?: string }
  | { kind: "deny";  reason: string }          // 终止：其后 hook 不再运行
  | { kind: "ask";   reason: string }          // 交给 UI 的待决态
  | { kind: "mutate"; input?: ...; text?: ... } // 改写主体，裁决留给规则层
```

**匹配**三选一（AND 组合）：`tool`（精确名或 `*`）、`toolRegex`（对工具名）、
`argPattern`（对参数正文的正则）。

`HookRunner.run(event, ctx)` 的语义：

1. 按**注册顺序**扫描，命中即执行；
2. `mutate` 会**串行改写**工作主体，后面的 hook 看到的是改过的输入；
3. `deny` 是**终止信号**，命中后后面的 hook 不再运行；
4. 返回审计记录 `records[]`（每个 hook 的 outcome）+ 最终主体。

## 4. 有序规则策略（`Policy`）

```ts
interface PermissionRule {
  id: string;             // 出现在裁决里，便于审计
  tool: string;           // 工具名或 "*"
  argPattern?: string;    // 对参数正文的正则
  decision: "allow" | "ask" | "deny";
  reason?: string;
}
```

**首个命中胜出**，所以顺序就是优先级。demo 规则（`fixtures/rules.json`）：

```
deny-secret-write > deny-destructive-rm > ask-push-main > ask-write
  > allow-read > default-shell > allow-list > default
```

底线规则是 `{"tool":"*","decision":"ask"}`——**未知即询问**，而不是默认放行。

> `argPattern` 匹配的正文是「参数序列化 + 每条字符串参数单独一行」（`m` 标志），
> 于是 `(^|/)\.env($|/)` 这种路径锚点不必和 JSON 引号搏斗。hook 的 `argPattern`
> 与规则共用同一个 `argumentHaystack()`。

## 5. 组合成一个 `decide()`

```
规则层给基线裁决  →  preToolUse hooks 依次运行
                    ├─ mutate：改写 input（裁决不变）
                    └─ allow / ask / deny：覆盖基线（最后一个显式裁决胜出）
                    deny 终止一切
```

返回的 `Decision` 含：`kind`、`pending`（`ask` 为 true，表示**待 UI 裁决**，不是
交互式弹窗）、`reason`、`source`（rule/hook/default）、`ruleId` / `hookId`、
改写后的 `input`、`mutated`、以及可读的 `trace[]`。

**为什么 `ask` 是 pending 而不是 prompt**：agent 循环里阻塞等人是灾难（会挂死、
破坏可回放性）。把它建模成一个**可序列化、可后置解析**的状态，UI 才有机会在事后
批准/拒绝，也才能在观测台里重放整条决策链。

## 6. Checkpoint（`mechanisms/checkpoint/`）

核心命题：**代码回滚 ≠ 对话回滚**。`CheckpointStore` 完全不认识消息数组、turn 的
对话含义或模型，它只记**文件字节**：

- `beginTurn(id)`：开始一轮，后续快照归入该 turn；
- `snapshot(file)`：记下**改之前**的字节。**同一 turn 内首次快照胜出**——
  这正是「本轮开始前的状态」；文件不存在则记为 *absent*；
- `restoreTurn(id)` / `restoreFile(id, file)`：把字节写回。若快照时不存在、
  之后被创建，则**删除**它；
- `verify(id)`：只读比对 sha256，不动磁盘；
- `CheckpointStore.open(dir)`：额外镜像到 `<dir>/checkpoints.json`（base64），
  进程重启后仍在。

恢复正确性用 **sha256 相等**判定，而非「写入成功」。演示里的往返（write → 覆写/
删除/新建 → restore）对文本、二进制（0..255）、以及「快照时不存在」三种情况都
断言字节相同。

**和对话解耦的意义**：用户可以对 agent 说「撤销刚才对代码的改动」，但仍然保留
对话历史（或者反过来只回滚对话、保留代码）。两者用不同的存储、不同的 id 空间，
没有隐式耦合。

## 7. API 速览

```ts
import { HookRunner, Policy, decide, loadHooksFromFixture }
  from "../../core/src/mechanisms/hooks/index.js";
import { CheckpointStore } from "../../core/src/mechanisms/checkpoint/index.js";

const hooks  = new HookRunner(await loadHooksFromFixture()); // fixtures/hooks.json
const policy = await Policy.fromFixture();                  // fixtures/rules.json

const d = await decide(policy, hooks, {
  tool: "run_shell",
  input: { command: "sudo apt-get install -y curl" },
  turnId: "turn-1",
});
// d.kind="ask"(规则 default-shell), d.mutated=true(命令被剥掉 sudo),
// d.input={command:"apt-get install -y curl"}, d.trace=[...]

// 文本生命周期点
const { text } = await hooks.runText("userPromptSubmit", "refactor auth");

// checkpoint
const store = CheckpointStore.inMemory();
store.beginTurn("turn-1");
await store.snapshot("src/app.ts");
await store.restoreTurn("turn-1");   // 字节级回退
```

## 8. 与现有 `core/src/permissions.ts` 的关系（未改动它）

`core/src/permissions.ts` 是 M0 留下的三层粗粒度闸门
（`yolo / standard / readonly`，只看 `tool.readOnly`）。M6 **不修改**它，而是在
自己的模块里实现更细的、数据驱动的层。两者是**互补而非替代**：

- 粗粒度模式决定「这个会话整体的姿态」；
- `Policy` + hooks 决定「这一次调用的具体裁决与改写」。

接线阶段（合并后）的合理做法是：模式为 `readonly/yolo` 时可直接短路，否则落到
`decide()`。这留给整合者，M6 只负责把缝的两端都实现清楚。

## 9. 设计取舍与边界

- **顺序即语义**：规则首个命中胜出、hook 按注册序执行——所以配置顺序必须稳定，
  否则同一调用可能得到不同裁决。demo fixture 的顺序是刻意的。
- **`deny` 终止、`allow` 不终止**：一条 hook 的 allow 只是「覆盖基线」，其后的
  hook 仍可能 deny。只有 deny 是不可翻盘的，避免「先放行后拦截」被绕过。
- **mutate 的可见性**：改写后的 input 会进 `Decision.input` 和 `trace`，所以
  「模型说要跑 X，实际跑了 Y」在审计里是可见的，不会被吞掉。
- **未做**：权限结果回灌给模型的话术（loop 集成）、hook 的沙箱/超时、
  checkpoint 的按会话上限与 GC、大文件的增量快照。都留到接线阶段。
- **无依赖、无网络、无模型调用**：全部 Node 内置能力手写。
