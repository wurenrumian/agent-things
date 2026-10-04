# Labs — 实验即教学工具

在这层之前，学习者必须回到终端，并记住精确的命令：

```bash
pnpm --filter @agent/server exec tsx scripts/forensics-experiment.ts
```

这对仓库作者没问题，但对任何想**学习**的人来说很不友好。**Labs** 把观测台变成一件
教学工具：一个 **Labs** 标签页把每个实验编成目录、说明各自证明了什么，并让输出**实时
流式**跑出来——不用终端、不用记路径。实验脚本本身原样复用；这一层只是启动器，不是重写。

## 三个部分

| 文件 | 作用 |
|---|---|
| `packages/server/src/labs/types.ts` | `Lab`、`LabKind`、`LabFrame` —— 共享形状 |
| `packages/server/src/labs/registry.ts` | **白名单**：每个实验脚本一条 |
| `packages/server/src/labs/runner.ts` | spawn + 流式输出 + 超时/kill + 同一时刻只跑一个 |
| `packages/server/src/index.ts` | `GET /api/labs`、`POST /api/labs/:id/run`（`streamSSE`） |
| `apps/web/src/components/LabsTab.tsx` | 标签页：目录、确认、实时控制台 |

## 1. 白名单（registry）

最重要的一个设计决策：**服务器绝不接受调用方传来的路径。** `POST /api/labs/:id/run`
用 id 去 `LABS` 里解析，唯一能进到 `spawn()` 的，是 registry 条目里的 `script` 字段。
未知 id 返回 `404`，而不是去读文件。这让端点无需校验层就能安全暴露，也让目录成为
"什么能跑"的唯一事实来源。

每个 `Lab` 都带上 UI 如实说明成本所需的一切：

```ts
interface Lab {
  id: string;            // 稳定 slug，作为 URL 段
  title: string;
  mechanism: string;     // cache, skills, hooks, …
  kind: "offline" | "api";
  apiCalls?: number;     // 该 harness 自己声明的调用预算
  estSeconds?: number;
  script: string;        // packages/server/scripts/ 下被白名单的文件
  docsRun: string;       // 记录在案的证据，docs/runs/*.md
  blurb: string;
}
```

`kind: "offline"` 表示该 harness 只用纯 `@agent/core` + `node:` 内置模块——不需要
`.env`、不联网。有三个实验符合（`forensics`、`hooks`、`scheduler`）；另外九个会连
OpenRouter，并带一个取自各自脚本头部注释的 `apiCalls` 预算。

## 2. runner（子进程 + 流式账本）

`LabRunner` 启动脚本，把 `stdout`/`stderr` 转成帧流。有四个关键的防护：

**可移植的启动方式。** `tsx` 通过*当前*的 `node` 可执行文件（`process.execPath`）运行
解析出的 `tsx` CLI JS 入口——绝不用 `.cmd` 垫片，因此在 Windows 和 POSIX 上行为一致。
CLI 入口的找法是：解析 `tsx/package.json` 并读取它的 `bin` 字段；pnpm 的符号链接布局
会让朴素的 `node_modules/tsx/...` 路径失效，而该包的 `exports` map 又封死了
`tsx/dist/cli.mjs` 这个子路径。

**环境透传。** 子进程继承 `process.env`，所以服务器启动时加载的仓库根 `.env` 对 API
实验可用。任何 key 都不会被复制进目录或 web bundle。

**超时杀整棵进程树。** `LAB_TIMEOUT_MS`（默认 `300000`）启动一个计时器；到期后整棵
进程**树**被杀死（Windows 上 `taskkill /T /F`，POSIX 上 `kill(-pid)`），并发出
`{ type:"exit", timedOut:true }`。单次 `tsx` 运行会再 spawn 出自己的子进程，所以只杀
直接子进程会漏掉真正的实验进程。

**同一时刻只跑一个。** `LabRunner.acquire()` 预留唯一一个槽位。路由在打开流**之前**
就预留它，因此并发请求会拿到一个真正的 `409 { error:"busy" }` JSON 响应，而不是一条
静默为空的 SSE 流。槽位在 `finally` 里释放，覆盖所有路径，包括客户端断开。

帧协议刻意做得很小：

```
{ type: "start",  id, command }          // once, announces the child
{ type: "stdout", line }                 // one line per frame
{ type: "stderr", line }
{ type: "exit",   code, durationMs, timedOut?, error? }   // terminal
```

行切分用一个增量切分器（`LineBuffer`）：某块在行中间结束时先缓冲，等剩余部分到达；
关闭时冲刷尾部。

### 值得点名的竞态

generator 先 yield `start`，然后挂起。在这段挂起期间，子进程可能已经跑完并推入它的
`exit` 帧。形如 `while (!closed) { … }` 的循环于是会**在没有排空队列的情况下**退出，
静默丢掉终止帧。循环必须写成 `while (!closed || queue.length > 0)`，这样缓冲的帧总会在
generator 结束前送达。

## 3. 路由

```jsonc
GET  /api/labs            -> { enabled, labs: Lab[] }
POST /api/labs/:id/run    -> text/event-stream of LabFrame
```

状态码：未知 id `404`，`LABS_ENABLED=false` 时 `403`，忙时 `409`。

## 4. web 标签页

`LabsTab` 拉取一次目录，按 `kind` 分组（offline 在前），渲染每一项的标题、blurb、
mechanism、`apiCalls` 和一个 `docsRun` 链接。运行一个 `api` 实验前会先弹
`window.confirm`，重申预算——让学习者在花钱之前就看到成本。运行时会渲染一个实时
控制台，`stderr` 有颜色区分，并显示退出状态/耗时；**Kill** 按钮中止
`AbortController`，从而关闭连接、让服务器杀掉进程树。页面加载时什么都不跑。

## 5. 如何新增一个实验

1. 在 `packages/server/scripts/<name>-experiment.ts` 下写 harness（或复用已有的——
   不要从这一层去改它们）。
2. 在 `registry.ts` 的 `LABS` 里加一条：id、title、mechanism、`kind`、
   `apiCalls`/`estSeconds`、`script`、`docsRun`，以及一句 blurb。
3. 把 `docsRun` 指向该机制在册的 run 记录。
4. `pnpm typecheck`；该实验就会出现在 `GET /api/labs` 和标签页里。

不需要改任何路由或 UI——目录驱动一切。

## 阅读地图

- `packages/server/src/labs/registry.ts` — 白名单与目录。
- `packages/server/src/labs/runner.ts` — spawn、行切分、kill、忙闸。
- `packages/server/src/labs/types.ts` — 帧与目录类型。
- `apps/web/src/components/LabsTab.tsx` — 标签页与其实时控制台。
- `docs/runs/l3-labs.md` — 这一层的启动/路由证据。
- `docs/CONTRACT.md` §"L3 Labs" — 冻结的 HTTP 契约。
