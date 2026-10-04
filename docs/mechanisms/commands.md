# 机制：斜杠命令 (slash commands) — M12

> 一句话：**斜杠命令是"输入预处理"，不是模型能力。** 它是宿主机在
> "要不要调模型"之前对输入做的处理；命中命令就走宿主逻辑（合成回复，或把
> 上下文**追加到尾部**再跑一轮），没命中就当普通输入原样喂给模型。
>
> 实测见 [`docs/runs/m12.md`](../runs/m12.md)。

## 1. 为什么不当成工具

把这些能力做成模型工具会付出两笔成本：

1. **常驻 schema 成本**：每个工具的描述都进 `tools` 数组，占用缓存前缀的字节
   （M4：MCP 工具约 165 token/个；M11：真实工具约 73 token/个）。
2. **路由责任错位**：让模型去判断"用户这句是不是命令"既不可靠也不必要——
   模式很明显（以 `/` 开头），宿主一眼就能判。

正确的层是**边缘拦截**：输入到达内核前，宿主先看它是不是一个**已注册**的命令。
这样既不花 schema 字节，也不改前缀。

## 2. 三个纯函数式的部件

机制自包含在 `packages/core/src/mechanisms/commands/`：

```ts
// registry.ts
parseCommand("/memory cache rule"); // { name: "memory", args: "cache rule" }
parseCommand("/help");              // { name: "help", args: "" }
parseCommand("/etc/hosts");         // null ← 是路径，不是命令
parseCommand("hello");              // null

class CommandRegistry {
  register(def: CommandDef): this;
  get(name: string): CommandDef | undefined;
  has(name: string): boolean;
  list(): CommandDef[];      // 按名字排序（和 ToolRegistry 同一条稳定性规则）
  parse(input: string): ParsedCommand | null;
  helpText(): string;        // /help 的正文由注册表生成
}
```

`parseCommand` 的正则是 `/^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/`。这个形状刻意
**不**匹配 `/etc/hosts`（`etc` 之后是 `/`，不是空白或结尾），所以路径、除号之类
的输入会原样落到模型。

## 3. 两种结果：合成回复 vs 尾部注入

命令处理器返回 `CommandResult`，**二选一**：

```ts
interface CommandResult {
  reply?: string;            // 合成回复：直接回给用户，不跑模型 turn
  inject?: ChatMessage[];    // 尾部注入：追加后再跑一轮模型 turn（缓存安全）
  data?: unknown;            // 可观测细节，写进 mechanism 事件
}
```

- **合成回复**（`/help` `/memory` `/workers` `/compact`）：宿主立刻给出结果，
  **零模型 turn**。这正是验收要的"无模型 turn 即响应"。
- **尾部注入**：命令把要进模型的字符**追加**到消息数组尾部，然后跑正常 turn。
  **绝不**改写 system 前缀——这是 M1/M2/M9 反复验证的缓存规则。`inject`
  分支的类型就是"追加用的消息"，从类型上堵死"重写前缀"。

## 4. 内置命令

`registerBuiltins(registry, host)` 注册四个命令。机制专属的能力通过
`CommandHost` **注入**（不是 import 别的机制），保持本目录零跨机制耦合：

| 命令 | 机制 | 行为 | 模型 turn |
|---|---|---|---|
| `/help` | 注册表自身 | 列出全部命令 | 否 |
| `/memory <query>` | M9 `recall` | 确定性召回，渲染 top-5 | 否 |
| `/workers` | M10 supervisor | worker 注册表 + usage 快照 | 否 |
| `/compact` | M3 `compactNow` | 立即压缩一次，回报告 | 否（压缩器内部可能调摘要模型） |

host 的闭包在机制关闭时返回 `undefined`，命令就回一句"disabled"而**不报错**：

```ts
registerBuiltins(registry, {
  recallMemory: (q) => rt.memories ? renderMemories(recall(q, { entries: rt.memories.entries })) : undefined,
  workerSnapshot: () => rt.supervisor ? format(rt.supervisor) : undefined,
  compactNow: async () => { const r = await agent.compactNow(); return r ? report(r) : undefined; },
});
```

## 5. 服务端拦截点

`POST /api/sessions/:id/messages` **在创建/驱动 turn 之前**拦截：

```
parsed = parseCommand(input)
cmd    = parsed ? buildCommandRegistry(rt, session).get(parsed.name) : undefined
if (cmd) {
  result = await cmd.handler(parsed.args, { sessionId, cwd })
  发一条 mechanism 事件： { name:"command", phase:<名>, data:{ args, reply, injected } }
  if (result.inject?.length) { agent.messages.push(...inject); 跑正常模型 turn }
  else if (typeof result.reply === "string") { 发合成 assistant.message + turn.end }
  return
}
// 否则：原样 agent.run(input) —— 未知斜杠输入照常进模型
```

选定的策略是 **未知命令回落到模型**（不是回 help 提示）：`/foo`、`/etc/hosts`
都当普通输入。理由：误判一个"以 `/` 开头的正常问题"去回 help，比让它进模型更烦人；
而真正想用命令的人，`/help` 就在那儿，且 `mechanism` 事件里能看到命令名。

命令的回复以 `assistant.message` 合成事件的形式走 SSE 并写事件日志；但**不**写进
`agent.messages`（不污染模型上下文）。刷新时代仍可在 Timeline 里看到
`mechanism/command` 记录。

## 6. 与缓存的关系

- 合成命令：**完全不产生请求**，零 token、零缓存影响。
- 注入命令：只在**尾部追加**消息；已缓存前缀逐字节不变。
- 命令名 / 用法 / 处理逻辑都不进 `tools`，所以不增加常驻前缀。

## 7. 设计取舍

- **注册表按名排序**：`/help` 输出稳定（与 `ToolRegistry.list()` 同规则）。
- **处理器无状态**：`CommandContext` 只带 `sessionId`/`cwd`，机制专属对象由 host
  闭包持有；`/compact` 需要活体 `Agent`，所以注册表按请求构建（成本可忽略）。
- **不做权限/审批**：命令是宿主的确定性逻辑，不调用模型，不产生工具副作用
  （`/compact` 除外，它只压缩历史）。
