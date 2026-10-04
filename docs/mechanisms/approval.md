# 机制：交互式审批 (interactive approval) — M12

> 一句话：**`ask` 不是"默认放行"，而是"停下来等人"。** M6 已经能判出 `ask`，
> 但循环把它当非交互处理——`yolo` 乐观放行，其它模式直接挡住。M12 把 `ask`
> 变成一次**被 await 的真实人机决策**：发 `approval.requested` → 阻塞在回调上
> → 收到 `allow`/`deny` → 发 `approval.resolved` → 执行或回灌拒绝。
>
> 实测见 [`docs/runs/m12.md`](../runs/m12.md)。

## 1. 问题：裁决点有了，人没接上

M6 的 `decide(policy, hooks, req)` 会返回三种裁决：

| 裁决 | M6 的语义 | M12 的语义 |
|---|---|---|
| `allow` | 放行 | 放行（不变） |
| `deny` | 挡住，回灌 `Denied:` 工具消息 | 不变 |
| `ask` | **待定**。`yolo` 下乐观放行；否则 `Blocked: pending approval (non-interactive)` | **暂停循环，等一个人点头** |

`ask` 是唯一一个"循环自己没法决定"的裁决：需要循环外的世界给个答案。M6 把它
降级成两种近似（乐观 or 阻断），因为当时没有交互通道。M12 补上这个通道。

## 2. 内核缝：`AgentConfig.approvals`

缝留在内核（`agent/loop.ts`），而且**加法式**：只有配置了 `approvals` 才生效。

```ts
export interface AgentConfig {
  // …
  approvals?: (req: {
    toolCallId: string;
    tool: string;
    input: Record<string, unknown>;
    turnId: string;
  }) => Promise<"allow" | "deny">;
}
```

`executeToolCall` 里的顺序（`tool.call` 已发、gate 已算出裁决）：

```
permission.decision(decision="ask")          // 永远先记录真实裁决
  └─ if (decision === "ask" && approvals) {
        yield approval.requested               // ① 请求（含 toolCallId/name/input/reason）
        const a = await approvals({...})       // ② 循环真正停在这里
        yield approval.resolved(a)             // ③ 裁决
        if (a === "deny") { push(Denied 工具消息); return; }   // 不执行
        // allow → 落到下面的执行路径
     } else if (decision === "ask" && mode !== "yolo") {
        push(Blocked: pending approval (non-interactive)); return;  // M6 旧行为
     }
  // 执行工具 → tool.result
```

关键不变式：**没有 `approvals` 时，代码路径与 M6 逐字节相同**（`yolo` 放行、
其它模式阻断）。所以所有既有实验不受影响。`events.ts` 只**追加**两个事件类型：

```jsonc
{ "type": "approval.requested", "toolCallId": "call_1", "name": "write_file",
  "input": { "path": "a.txt", "content": "…" }, "turnId": "s-t1",
  "reason": "writes mutate the workspace", "at": 1791096373414 }
{ "type": "approval.resolved", "toolCallId": "call_1",
  "decision": "allow", "at": 1791096373677 }
```

> `approval.requested` 里的 `input` 是 **gate 改写之后**要执行的输入（例如
> `preToolUse` hook 改过路径），所以人看到的就是"真正将发生的事"。

## 3. 为什么必须是异步、可等待

M6 的 `decide()` 是纯函数，返回 `pending: true`；它**从不弹窗、不调模型**。
M12 也不让内核自己做 UI：内核只提供"一个返回 promise 的回调"，把"谁来问人"
留给宿主（server / TUI / 桌面端）。这正是"内核与传输解耦"（L8）的延续——
审批通道可以换，循环一行不改。

`await` 的意义在实验里可直接量：回调里 `sleep(250ms)`，则
`approval.resolved.at - approval.requested.at ≈ 263ms`（见 run doc）。循环确实
停在 promise 上，而不是"发个事件继续跑"。

## 4. Server：pending map + 路由 + 超时

宿主把回调接到 HTTP：

- `Runtime.approvals: Map<` `${sessionId}:${toolCallId}` `, resolve>`；每个
  `Agent` 在 `getAgent` 时挂上 `approvals: (req) => requestApproval(rt, session.id, req)`。
- `POST /api/sessions/:id/approvals` `{ toolCallId, decision: "allow"|"deny", reason? }`
  → 找到 resolver 并 resolve；`404` 未知会话，`409` 没有 turn 在该 toolCallId 上等待，
  `400` 参数非法。
- **超时兜底**：`requestApproval` 用 `setTimeout(APPROVAL_TIMEOUT_MS)`（默认 30s）
  到点 resolve `deny` 并清掉 map 项。这样"gate 返回 ask 但没人应答"的 turn
  **永远不会挂死**；安全默认是拒绝（fail closed）。定时器**不** `unref`：审批
  挂起期间保持事件循环存活正是想要的语义。
- SSE：`approval.requested` / `approval.resolved` 与其它事件同帧下发（`event:` =
  类型，`data:` = 完整事件 JSON），并写进事件日志。turn 的 SSE 流保持打开，
  另一个 HTTP 请求（POST approvals）在它阻塞期间解析同一 promise。

## 5. Web：最小但真实

`approval.requested` 到达时，对话区上方出现一个 Allow/Deny 控制条，列出
工具名、原因和（格式化后的）输入；点按即 `POST …/approvals`。`approval.resolved`
到达时清除。它不做乐观 UI——但服务端的超时保证它也不会永远挂着。

## 6. 设计取舍

- **fail closed**：超时→`deny`。企业审批里"沉默不等于同意"。
- **不改 `ask` 的裁决语义**：`permission.decision` 仍记录真实 `ask`；审批只是
  "如何解决 ask"。
- **审批事件不进模型上下文**：它们只写事件日志/SSE；模型只看到最终的工具结果
  或 `Denied:` 消息。模型不需要知道"有人点过按钮"。
- **`reason` 字段**：路由接受 `reason` 以便宿主审计/展示，但回调协议只返回
  `allow|deny`，因此 `approval.resolved` 只带裁决。

## 7. 与缓存的关系

审批发生在 **工具调用之间**，不触碰消息数组的已缓存前缀：allow 时照常追加
`role:"tool"` 结果；deny 时追加一条 `role:"tool"` 的 `Denied:` 消息。两者都是
**尾部追加**，system / tools / 历史前缀一字未改（M1/M2/M9 的缓存规则）。
