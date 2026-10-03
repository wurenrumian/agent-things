# 架构 (ARCHITECTURE)

## 1. 仓库布局

```
agent-things/
├─ packages/
│  ├─ core/       # 内核：类型、事件、模型客户端、上下文装配、工具、循环、存储
│  │  └─ src/
│  │     ├─ types.ts              # 线格式类型（贴近 OpenAI chat-completions）
│  │     ├─ events.ts             # AgentEvent 词汇表（全局单一事件语言）
│  │     ├─ content.ts            # content 组装 + 缓存断点标记 + 粗估 token
│  │     ├─ permissions.ts        # L7 闸门缝（M0 非交互）
│  │     ├─ context/system-prompt.ts  # L1 系统提示装配 + AGENTS.md 发现
│  │     ├─ provider/openrouter.ts    # L2 手写 OpenRouter 流式客户端
│  │     ├─ tools/{registry,builtin}.ts # L4 工具注册表 + 内置工具
│  │     ├─ agent/loop.ts         # L0 agent 循环（async generator）
│  │     └─ store/session.ts      # L6 会话 + 事件日志（node:sqlite）
│  └─ server/     # HTTP + SSE，把 core 包起来
└─ apps/
   └─ web/        # 上下文观测台（Vite + React）
```

依赖方向：`core` ← `server` ← `web`（web 只通过 HTTP 与 server 通信）。
`core` 不依赖任何传输层，这保证同一内核可被 CLI / 桌面复用。

## 2. 分层与机制地图的对应

| 层 | 位置 | 机制 |
|---|---|---|
| L0 循环内核 | `agent/loop.ts` | tool loop、状态机、停止条件 |
| L1 上下文装配 | `context/system-prompt.ts` | system 分段、环境注入、AGENTS.md |
| L2 缓存与 token 经济 | `provider/openrouter.ts`、`content.ts` | 缓存断点、usage、sticky routing |
| L3 上下文回收 | *（M2/M3 待建）* | 压缩、tool-result clearing |
| L4 能力扩展 | `tools/`、*（M2/M4 待建）* | 工具、skill、MCP |
| L5 委派与并发 | *（M5 待建）* | subagent、background、scheduled |
| L6 会话与状态 | `store/session.ts` | 持久化、事件日志、fork |
| L7 安全权限 | `permissions.ts` | 审批、沙箱缝 |
| L8 交互外壳 | `server/`、`apps/web/` | 事件流、观测面板 |

## 3. 核心接口

### 3.1 事件词汇表（`events.ts`）

整个系统只说一种语言：`AgentEvent`。循环产出，server 持久化 + 广播，
web 渲染。这是"可观测优先"原则的落点。

```
turn.start       一次用户输入开始
context.compiled 本轮实际要发送的完整消息数组 + 组成统计
request.sent     真正发出（之前）的请求体
text.delta       流式文本增量
assistant.message 组装完成的 assistant 消息（含 tool_calls）
permission.decision 每个工具调用的裁决
tool.call        工具调用开始
tool.result      工具结果 + 耗时 + 是否错误
usage            provider 返回的 token / 缓存用量
turn.end         结束（stop | max_steps | error | aborted）
```

### 3.2 Agent 循环

```ts
class Agent {
  readonly sessionId: string;
  messages: ChatMessage[];
  run(input: string, signal?: AbortSignal): AsyncGenerator<AgentEvent>;
}
```

一个 turn 的状态机：

```
push(user) → [compile context → request → 有 tool_calls?]
                              ├─ 有 → 逐个裁决/执行 → push(tool) → 回到 compile
                              └─ 无 → stop
```

关键不变式：

- `messages` **只追加，从不原地修改**。`compileMessages()` 每次都是
  `[system, ...history]`。这是缓存前缀稳定的前提，也是与 Codex 团队做法
  （改配置/改 cwd 时插入新消息而非改写旧消息）一致的思路。
- `system` 消息用 `withCacheBreakpoint()` 标记缓存断点（OpenRouter 透传
  `cache_control`）。
- **工具顺序稳定**：`ToolRegistry.list()` 按名字排序。工具枚举顺序抖动会
  导致缓存失效（Codex 早期 MCP 支持的真实 bug）。

### 3.3 手写 OpenRouter 客户端

```ts
class OpenRouterClient {
  chatStream(opts, cb): Promise<ChatStreamResult>;
}
```

- 纯 `fetch` + 手写 SSE 解析，请求体自己拼。
- 支持生成器回调 `onRequest`：在发送**之前**把原始请求体交给观测台。
- content 拆成 parts 以支持 `cache_control`。
- 传 `session_id` 触发 OpenRouter 的 provider sticky routing——同一会话固定
  落到同一 provider，是缓存命中的前提。
- 返回 `usage`，含 `prompt_tokens_details.cached_tokens` / `cache_write_tokens`。

### 3.4 存储（L6）

`Store`（`node:sqlite`）三张表：

- `sessions`：会话元信息。
- `events`：**追加型事件日志**，每次 `AgentEvent` 一条，可回放、可比对。
- `messages`：当前上下文数组的 JSON 快照。

保留两者是刻意的：`events` 记录"发生了什么"，`messages` 记录"模型现在看到
什么"。两者的差异正是压缩、清理、fork 等机制的观察对象。

## 4. 数据流

```
web ⇄ HTTP/SSE ⇄ server ⇄ Agent.run() ⇄ core
                    │
                    ├─ Store (events, messages) → data/agent.db
                    └─ OpenRouterClient → openrouter.ai
```

`POST /api/sessions/:id/messages` 返回 `text/event-stream`，每个 `AgentEvent`
一帧（`event: <type>` / `data: <JSON>`），`turn.end` 后结束。

完整接口见 `docs/CONTRACT.md`（已冻结）。

## 5. 为什么这样分层（教学动机）

- **事件流而非日志**：如果把事件只当日志，就无法用它驱动 UI，也无法用它
  做实验对照。把它做成一等公民，机制才"看得见"。
- **内核与传输解耦**：这样"加一个 TUI"只是加一个消费者，而不是重写循环。
- **手写关键路径**：任何封装都会把"消息怎么拼、缓存怎么标、工具 schema 怎么
  排序"藏起来，而这三件事恰好是本项目要研究的东西。
- **接口先冻**：冻结 `AgentEvent` + HTTP 契约后，skills / MCP / compaction /
  subagent 各自只在内核内部新增事件与模块，可以独立并行开发与合并。
