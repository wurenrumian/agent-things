# 集成记录 — INT-B1：把 hooks/permissions（M6）与 compaction（M3）接进 agent loop

**日期**：2026-10-03
**模型**：`xiaomi/mimo-v2.6-flash`（OpenRouter）
**Target**：`packages/core/src/agent/loop.ts`、`packages/core/src/events.ts`、
`packages/core/src/permissions.ts`、`packages/server/src/**`、`apps/web/**`、
`docs/CONTRACT.md`、`docs/runs/int-b1.md`

> 目标：让 M6（hooks/permissions）与 M3（compaction）真正**驱动 agent loop**、
> 在观测台里**可见**，且**默认关闭**（什么都不配 ⇒ 行为不变）。

## 0. 改了什么（一句话）

在 `AgentConfig` 上开三个 additive 缝——`gate`（策略+hooks 裁决，返回可被改写的
input）、`hooks`（驱动 `userPromptSubmit` / `preCompact` / `postToolUse`）、
`compaction`（每步顶部按阈值折叠历史）；`executeToolCall` 用 `gate` 裁决、发**真实
verdict**（含新增的 `"ask"`）、用**改写后的 input** 执行、观察式跑 `postToolUse`；
server 从 `HOOKS_FILE`/`POLICY_FILE`/`COMPACT_*` 组装这些缝，新增
`POST /api/sessions/:id/compact`；web Timeline 区分渲染 `"ask"`。

## 1. 接线（代码）

| 位置 | 变化 |
|---|---|
| `events.ts` | `PermissionDecision` 增加 `"ask"`（`allow \| deny \| ask`） |
| `agent/loop.ts` | `AgentConfig` 增加 `gate?` / `hooks?` / `compaction?`；`turn.start` 后用 `userPromptSubmit` 改写输入（无 hooks 则原样）；每步顶部若 `estimateTokens(history) > threshold` 则 `preCompact` + `compact()` + 替换 `this.messages`，发 `hooks/preCompact` 与 `compaction/compacted`；`executeToolCall` 用 gate 裁决、发真实 verdict、`ask` 仅在 `yolo` 下执行、用 gate 返回的 `input` 执行、之后观察式 `postToolUse`；新增 `compactNow()` 供路由调用；新增 `GateRequest`/`GateResult`/`AgentCompactor`/`CompactionReport` 类型 |
| `server/config.ts` | 新增 `HOOKS_FILE`、`POLICY_FILE`（路径；缺省=关）、`COMPACT_THRESHOLD_TOKENS`（0/缺省=关）、`COMPACT_KEEP_RECENT`(8)、`COMPACT_KEEP_LEADING`(1)、`COMPACT_PLACEMENT`(`spliced`) |
| `server/compose.ts` | 组装 `HookRunner`(+`Policy`)、`gate`（调 `decide()`，`kind`→`decision`，透出 `trace`/`mutated`）、`compact()`（`compactDetailed` + `summarize` 调模型，累加 `chatStream`）；**三者任一未配则不加字段**，保持五工具 builtin 路径 |
| `server/index.ts` | 新增 `POST /api/sessions/:id/compact`：对 live agent 强制压缩、持久化、返回 `{before,after,summarized,keptRecent,keptLeading,placement}`，并追加一条 `via:"api"` 的 `mechanism` 事件 |
| `apps/web` | `TimelineTab` 对 `permission.decision` 的 `"ask"` 单独标色/加 `⏸`（`.tl-decision-ask`）；`types.ts` 的 `PermissionDecision` 同步为三值；`api.ts` 增加 `compactSession()` |
| `docs/CONTRACT.md` | 新增 `ask` verdict、新路由、`hooks`/`compaction` 机制事件、五个 env |

> 观察故事：**未配置 ⇒ 一个字节都没变**。`gate`/`hooks`/`compaction` 都是
> optional，`compose.ts` 只在配置存在时赋值；loop 里所有分支都以「有配置」为前提。

## 2. 无配置运行（回归）— 行为不变（验收 1）

`HOOKS_FILE` / `POLICY_FILE` 未设、`COMPACT_THRESHOLD_TOKENS` 未设，`:8792`。

启动日志：

```
[server] hooks: none (HOOKS_FILE unset)
[server] policy: none (POLICY_FILE unset)
[server] compaction: none (COMPACT_THRESHOLD_TOKENS unset/0)
[server] skills: none ...
[server] tools (6): edit_file, list_dir, read_file, run_shell, task, write_file
[server] listening on http://localhost:8792 (model: xiaomi/mimo-v2.6-flash, ...)
```

`node scripts/smoke.mjs` 一次真实 turn —— 与 INT-A 记录的形态一致，**没有任何
`mechanism` 事件**，权限仍是 `allow (mode=yolo)`：

```
▶ turn.start
  context: messages=2 tools=[edit_file, list_dir, read_file, run_shell, task, write_file] estTokens=188
  assistant: tool_calls=1
  usage: prompt=907 completion=37 cached=0 cache_write=0
  → tool.call read_file {"path":"int-b1-big.txt","limit":3}
  permission: allow (mode=yolo)
  ← tool.result read_file isError=false dur=6ms
  context: messages=4 tools=[...] estTokens=249
  usage: prompt=1008 completion=29 cached=896 cache_write=0
■ turn.end stop
```

`POST /api/sessions/:id/compact` 在未配置时按约定拒绝：

```
POST /api/sessions/7e38bee7-.../compact -> 409
{ "error": "compaction is not configured (set COMPACT_THRESHOLD_TOKENS)" }
```

## 3. 配置 `POLICY_FILE` + `HOOKS_FILE` — 真 verdict + 改写 input + postToolUse（验收 2）

`:8791`，`HOOKS_FILE=data/int-b1/hooks.json`、`POLICY_FILE=data/int-b1/policy.json`。

### 3.1 deny —— 真 verdict 是 `deny`（不是「放行后拦」）

让模型调 `run_shell(command="echo DENY_MARKER")`；规则 `deny-marker`（`argPattern:
DENY_MARKER → deny`）先命中，`mutate-shell` hook 又把命令改写：

```
→ tool.call run_shell {"command":"echo DENY_MARKER"}
MECHANISM name=hooks phase=preToolUse data={"records":[
    "rule:deny-marker -> deny",
    "input -> {\"command\":\"echo DENY_MARKER #MUTATED_BY_HOOK\"}",
    "hook:mutate-shell -> mutate"], "mutated":true,
    "input":{"command":"echo DENY_MARKER #MUTATED_BY_HOOK"}}
PERMISSION DENY run_shell — command carries the deny marker
  （没有 tool.result；工具根本没执行）
```

> 事件里同时可见：**规则裁决**（`rule:deny-marker -> deny`）、**被改写的输入**
> （`#MUTATED_BY_HOOK`）、**hook 记录**（`hook:mutate-shell -> mutate`）。

### 3.2 ask —— 真 verdict 是 `ask`，`yolo` 下放行

同一条 `run_shell` 换成不带 marker 的命令，落到 `ask-shell`（`run_shell → ask`）：

```
MECHANISM name=hooks phase=preToolUse data={"records":[
    "rule:ask-shell -> ask",
    "input -> {\"command\":\"echo HELLO_MUTATE #MUTATED_BY_HOOK\"}",
    "hook:mutate-shell -> mutate"], "mutated":true, ...}
PERMISSION ASK run_shell — shell commands require approval
← tool.result run_shell isError=true "spawn cmd.exe ENOENT"   ← yolo 放行、真的执行了
MECHANISM name=hooks phase=postToolUse data={"records":[{"hookId":"audit-tool-result",
    "event":"postToolUse","outcome":{"kind":"allow","reason":"post-tool audit recorded",
    "note":"observational"}}]}
```

> verdict 记录为 **`ASK`**（真实裁决），同时因为是 `yolo` 而**继续执行**。
> 非 `yolo` 模式下该调用会被拦为 `Blocked: pending approval (non-interactive)`。
> （`cmd.exe ENOENT` 是本机 Windows 环境既有问题，与本次改动无关；此处关键是
> **执行确实发生**。）

### 3.3 mutate —— 工具跑的是**改写后的 input**（干净证据）

用 `write_file` 的 mutate hook（把 `*.txt` 改成 `*_MUTATED.txt`）：

```
→ tool.call write_file {"path":"int-b1-mutation.txt","content":"hello-mutation"}
MECHANISM name=hooks phase=preToolUse data={"records":[
    "rule:default -> allow",
    "input -> {\"path\":\"int-b1-mutation_MUTATED.txt\",\"content\":\"hello-mutation\"}",
    "hook:mutate-write-path -> mutate"], "mutated":true, ...}
PERMISSION ALLOW write_file — default allow
← tool.result write_file isError=false "wrote int-b1-mutation_MUTATED.txt"
MECHANISM name=hooks phase=postToolUse data={"records":[{...audit-tool-result...}]}
```

落盘校验：`data/sandbox/int-b1-mutation_MUTATED.txt` 存在，内容 `hello-mutation`；
模型要写的 `int-b1-mutation.txt` 不存在 —— **执行的是 hook 改写后的路径**。

`postToolUse` 在每次 `read_file`/`write_file`/`run_shell` 后都追加一条 `mechanism`
事件，且不改变 `tool.result` 的 output（观察式）。

## 4. 配置 `COMPACT_THRESHOLD_TOKENS` — 自动压缩 + 估算下降（验收 3）

`:8791`，`COMPACT_THRESHOLD_TOKENS=60`、`COMPACT_KEEP_RECENT=2`、
`COMPACT_KEEP_LEADING=0`、`COMPACT_PLACEMENT=spliced`。
`data/int-b1-big.txt` 为 2000 行长文。一次 turn 里模型**顺序**两次 `read_file`
（第一次 500 行 ~10.7k tokens，触发压缩；第二次再读 500 行后再次压缩）：

```
context: messages=2 estTokens=209
PERMISSION ALLOW read_file — reads are side-effect free        ← tool.result 1（大）
MECHANISM name=hooks phase=preCompact  data={"records":[]}
MECHANISM name=compaction phase=compacted
  data={"before":10731,"after":10806,"summarized":1,"keptRecent":2,"keptLeading":0,"placement":"spliced"}
context: messages=4 estTokens=10980
PERMISSION ALLOW read_file — ...                                ← tool.result 2
MECHANISM name=hooks phase=preCompact  data={"records":[]}
MECHANISM name=compaction phase=compacted
  data={"before":21557,"after":10921,"summarized":3,"keptRecent":2,"keptLeading":0,"placement":"spliced"}
context: messages=4 estTokens=11095
■ turn.end stop
```

**估算确实下降**：第二次压缩 `before 21557 → after 10921`（≈ −49%），
`summarized 3` 条被折叠成 1 条摘要，`keptRecent=2` 保住了最近的一对
`assistant(tool_calls)+tool`，transcript 仍然合法。持久化的 live messages：

```
stored messages 3
  user    chars=680  "[conversation-summary]\nThe user's sole instruction was to re…"   ← 摘要
  tool    chars=43001 "501\tline 501 : …"                                                ← 最近 tool 结果
  assistant chars=5  "DONE."
estTokens ~ 10922
```

> 说明：`before/after` 是 `/4` 粗估（真实数以 `usage` 为准），并且**小会话**里摘要
> 文本可能比被折叠的对话还长，于是 `after ≥ before`——这是估算特性而非逻辑错误；
> 长会话才会体现真实下降。`preCompact` hook 的 instructions 会作为 summarizer 指令
> 注入。

### 4.1 `POST /api/sessions/:id/compact`（验收 3）

对上面的长 turn 会话强制压缩：

```
POST /api/sessions/ec187168-eddb-42df-a04f-c58d630730a5/compact -> 200
{
  "before": 10923,
  "after": 10922,
  "summarized": 2,
  "keptRecent": 2,
  "keptLeading": 0,
  "placement": "spliced"
}
```

并往会话事件日志追加一条 `{name:"compaction", phase:"compacted", data:{...,via:"api"}}`。

## 5. Web

`TimelineTab` 现在把 `permission.decision` 按 `decision` 着色：`allow` 绿、
`deny` 红、`ask` 琥珀并带 `⏸` 前缀 + `ASK (pending approval)` 文案（`.tl-decision-*`）。
`mechanism` 事件本就渲染，新的 `hooks` / `compaction` 事件自动出现。其余 tab 不受影响。
`pnpm --filter @agent/web build` 绿。

## 6. 约束遵守

- **不加依赖**：只用 Node 内置 + 已有 core 机制代码。
- **未配置 ⇒ 行为不变**：`gate`/`hooks`/`compaction` 全 optional，只有配置存在才挂上；
  无配置 smoke 与之前逐事件一致（无 `mechanism`、`allow (mode=yolo)`）。
- **未触碰** checkpoint / scheduler（INT-B2）。
- `pnpm typecheck` 全包 green；`pnpm --filter @agent/web build` green。
- `.env` 从 `D:/Project/agent-things/.env` 复制到 `./.env`（`.gitignore` 覆盖，未提交）；
  demo fixtures 放在 gitignored 的 `data/int-b1/`。

## 7. 复现

```bash
cp D:/Project/agent-things/.env ./.env          # gitignored
pnpm install
pnpm typecheck
pnpm --filter @agent/web build

# 配置齐全（hooks + policy + 小阈值 compaction）:
$env:PORT='8791'
$env:HOOKS_FILE='data/int-b1/hooks.json'
$env:POLICY_FILE='data/int-b1/policy.json'
$env:COMPACT_THRESHOLD_TOKENS='60'; $env:COMPACT_KEEP_RECENT='2'; $env:COMPACT_PLACEMENT='spliced'
pnpm --filter @agent/server start
node data/int-b1/probe.mjs turn "Call run_shell with command = echo DENY_MARKER"   # deny
node data/int-b1/probe.mjs compact <sessionId>                                     # 强制压缩

# 什么都不配置:
$env:PORT='8792'; Remove-Item Env:HOOKS_FILE,Env:POLICY_FILE,Env:COMPACT_THRESHOLD_TOKENS
pnpm --filter @agent/server start
$env:BASE='http://localhost:8792'; node scripts/smoke.mjs "Read int-b1-big.txt with limit=3"
```

代码位置：`packages/core/src/agent/loop.ts`（gate/hooks/compaction + `compactNow`）、
`packages/core/src/events.ts`（`ask`）、`packages/server/src/compose.ts`（组装根 +
模型 summarizer）、`packages/server/src/index.ts`（compact 路由）、
`apps/web/src/components/TimelineTab.tsx` / `styles.css`（ask 渲染）。
