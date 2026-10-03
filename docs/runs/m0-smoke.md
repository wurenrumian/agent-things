# 实验记录 — M0 验收（read → edit → run）

**日期**：2026-10-03
**模型**：`stealth/space-bunny-alpha`（OpenRouter，免费）
**权限**：`yolo`　**AGENT_CWD**：`data/sandbox`

## 任务

> Read greet.mjs, add a `farewell(name)` function returning `'Bye, <name>!'`,
> make the script also print it, then run it with node and report the output.

## 结果：通过

工具序列，一轮到底：

| step | 上下文消息数 | 工具调用 | prompt | completion | **cached** |
|---|---|---|---|---|---|
| 1 | 2 | `read_file greet.mjs` | 980 | 36 | 138 |
| 2 | 4 | `edit_file` | 1066 | 137 | 138 |
| 3 | 6 | `run_shell node greet.mjs` | 1223 | 31 | **1201** |
| 4 | 8 | —（收尾） | 1253 | 90 | 128 |

第 3 步 `run_shell` 返回 `Hello, world!` / `Bye, world!`，与写入的文件一致。
第 4 步无工具调用，`turn.end stop`。

## 观测到的缓存行为（M1 的种子）

- 第 1、2 步 `cached=138`，是一个很小的固定值——像是 system 前缀里一小段稳定区。
- 第 3 步 `cached` 跳到 **1201**（占 prompt 的 98%）——provider 缓存被预热，
  整个稳定前缀命中。这印证了 `docs/MECHANISMS.md` §3 的说法：**前缀稳定则命中**。
- 第 4 步 `cached` 又掉回 **128**。原因待查（候选：稳定前缀被上一步的 tool result
  挤动而重排、provider 缓存窗口/分片策略、或 `session_id` sticky routing 的边界）。
  **这是 M1 的第一个实验问题。**

## 附：验收中发现并修复的 bug

首轮 smoke 在 `edit_file` 之后崩溃：`turn.end error: Cannot read properties of null
(reading 'map')`。定位为 `packages/core/src/content.ts` 的 `contentToText` 未处理
`null`——而"只有 tool_calls、没有文本"的 assistant 消息 `content` 恰为 `null`，
`buildBreakdown()` 遍历时触发。修复：`contentToText` 接受 `null | undefined` 并
返回空串。

> 教训：这类 bug 只有把**真实模型**接进来跑完整循环才会暴露；纯单测覆盖不到
> "content 为 null 的 assistant 消息"。

## 复现

```bash
pnpm dev                                   # :8787 server, :5173 web
node scripts/smoke.mjs "<task>"
```
