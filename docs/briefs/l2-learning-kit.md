# Worker brief — L2: Learning kit (myths vs measured + the three lessons)

Read `docs/briefs/_learn-constraints.md`, `docs/SPEC.md` §3, and
`original_request.md` first; they are binding. Then read **all** of:
`docs/MECHANISMS.md` (§7 especially), `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`,
and every file under `docs/runs/` plus `docs/mechanisms/`.

## The learning goal

This project exists because the mechanisms "说不清楚". The densest learning
artifacts are therefore: (a) a page that collects every belief we **overturned
with real data**, and (b) a path that walks a newcomer through the *original
three lessons* in order. This brief produces exactly those two documents.

## Target (create ONLY these two files — edit nothing else)

- `docs/MYTHS.md`
- `docs/LEARNING.md`

You must **not** modify any existing file (no README/ROADMAP/MECHANISMS edits;
those are a later INT). No code, no dependency, no `.env`, no API calls.

## Change

### 1. `docs/MYTHS.md` — 常识 vs 实测

For each belief, give four fields: **常见说法 → 操作化问题 → 实测数字 → 结论**,
each ending with a link to the exact run doc. Pull numbers **verbatim** from the
run docs; invent nothing. Cover at least:

- skill 取用会不会炸 KV cache（M2）；
- "改 system 就一定失效"？（M1 / M2 的修正）；
- MCP 是不是 eager、加/重排一个工具的真实代价（M4）；
- 压缩是否必然 miss、摘要位置的影响（M3）；
- subagent 的成本模型：主上下文省了多少、总 token 花了多少（M5）；
- memory 的注入位置对缓存的影响（M9）；
- 排 25 个工具 vs 一个门面：lazy 省多少（M11）；
- 编排：主上下文 vs 总 token 的取舍（M10）；
- 权限/checkpoint 这类"实现型"里程碑没有缓存数字，也要如实标注（M6/M7）。

End with a one-line "这些结论怎么来的" pointing at MECHANISMS §0–§7 and the
measurement method (real `usage.prompt_tokens_details.cached_tokens`).

### 2. `docs/LEARNING.md` — 三节课学习路径

Map the repo to 立党 post 的三节课（见 `original_request.md`）:

- **第一课**：买 plan、用 claude-code / codex。
- **第二课**：自己写最小 coding agent。指向 `docs/SPEC.md`、`docs/ARCHITECTURE.md`、
  最小循环 `packages/core/src/agent/loop.ts`、`docs/runs/m0-smoke.md`。
- **第三课**：逐个机制。每一章用统一结构：**一句话心智模型 → 实现文件
  （`packages/core/src/mechanisms/<name>/`）→ 实验脚本
  （`packages/server/scripts/<name>-experiment.ts`）→ 实测数字（链到
  `docs/runs/<...>.md`）→ 一个"钩子问题"**。按依赖从简到难排（建议
  缓存 → skills → MCP → compaction → subagent → hooks/checkpoint →
  scheduler → memory → orchestrator → tool-search → approvals/commands）。

再加两节：

- **怎么自己复现**：`.env`/模型、`pnpm install`、各实验脚本的运行命令、
  "数字可能随模型/日期漂移"的说明。
- **读代码的入口**：从 `agent/loop.ts` → `content.ts` → `provider/openrouter.ts`
  → `tools/` 的主线，再进 `mechanisms/`。

## Constraints

- 中文为主，术语可保留英文；每个数字必须能在对应 run 文档里找到。
- 只写"是什么/为什么/怎么验证"，不要调整既有结论。
- 两个文件都要是合法 Markdown，链接用仓库相对路径。

## Ownable acceptance

- `docs/MYTHS.md` 与 `docs/LEARNING.md` 存在，且**由你新建**（无对既有文件的改动）。
- 每条实测数字都能对回 `docs/runs/*.md`；`git diff --stat` 只显示这两个新文件。
- 覆盖上面列出的全部条目。

## Finish protocol

Send `worker_done` with `--outcome succeeded`, both lifecycle IDs, a 3-sentence
summary, `--files-modified`, `--report-path docs/LEARNING.md`. Then stop.
