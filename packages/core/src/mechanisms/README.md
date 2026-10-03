# `packages/core/src/mechanisms/` — 约定

每个机制一个子目录，**自包含**，尽量不改核心文件。这样多个机制可以在各自的
Orca worktree 里并行开发、合并时零冲突。

## 目录布局

```
packages/core/src/mechanisms/<name>/
  index.ts        # 该机制的出口（factory / 类 / 工具定义）
  ...             # 该机制自己的实现文件
```

`<name>` 用短横线小写，例如 `skills`、`mcp`、`subagent`。

## 铁律

1. **只新增本目录下的文件**，不要修改 `packages/core/src` 里任何已有文件
   （`types.ts` / `events.ts` / `index.ts` / `agent/loop.ts` / `tools/**` / …）。
2. 复用核心代码用相对路径：`../../provider/openrouter.js`、`../../agent/loop.js`、
   `../../types.js` 等。
3. **不新增任何依赖**。需要外部能力时手写（MCP = stdio 上的 JSON-RPC；skill =
   frontmatter 手解析）。确实需要依赖时，停下来发 `question`，不要自行改 `package.json`。
4. 机制通过**注册一个工具**或**返回一段消息**接入，而不是修改循环。
   server 的组装由协调者在合并时完成。
5. 可观测性：先落在实验脚本的 stdout 与 `docs/runs/<name>.md` 里。

## 实验脚本

放在 `packages/server/scripts/<name>-experiment.ts`（新文件）。从脚本引机制用
相对路径：

```ts
import { /* ... */ } from "../../core/src/mechanisms/<name>/index.js";
import { OpenRouterClient } from "@agent/core";
```

用 `pnpm --filter @agent/server exec tsx scripts/<name>-experiment.ts` 运行。

## 为什么这样

内核保持"传输无关、机制可插拔"。并行的三个机制各自只写自己的目录，`git merge`
时不会有任何重叠文件；把它们接进 HTTP server / 观测台是合并后的独立一步。
