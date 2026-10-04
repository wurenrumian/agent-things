# L3 — Labs（运行报告）

**目标。** 把观测台变成一件教学工具：一个 **Labs** 标签页，把每个
`packages/server/scripts/*-experiment.ts` harness 编成目录，并让输出实时流式跑出来。
复用这些脚本；不新增依赖；labs 关闭时服务器其余部分逐字节不变。

**结果。** 已实现并端到端验证。`pnpm typecheck`（4 个包）与
`pnpm --filter @agent/web build` 全绿；`GET /api/labs` 返回完整的 12 个实验目录；离线
`forensics` 实验流式输出分类表并以 `0` 退出；并发的第二次运行返回 `409`；未知 id 返回
`404`；`LABS_ENABLED=false` 让路由失效而服务器其余部分不变。提交为 `L3: labs`。

## 改了什么

- `packages/server/src/labs/types.ts`（新增）—— `Lab`、`LabKind`、`LabFrame`。
- `packages/server/src/labs/registry.ts`（新增）—— 12 条目的**白名单**。
- `packages/server/src/labs/runner.ts`（新增）—— spawn + 行帧流、杀进程树超时、
  客户端断连即杀、同一时刻只跑一个的闸。
- `packages/server/src/config.ts` —— `LABS_ENABLED`（默认 `true`）、
  `LAB_TIMEOUT_MS`（默认 `300000`）。
- `packages/server/src/index.ts` —— `GET /api/labs`、`POST /api/labs/:id/run`。
- `apps/web/src/components/LabsTab.tsx`（新增）+ `Observatory.tsx`、`api.ts`、
  `types.ts`、`styles.css` —— Labs 标签页、目录 + 确认 + 实时控制台。
- `docs/CONTRACT.md` —— 新路由、新 env、Labs 标签页说明。
- `docs/labs.md`（新增）—— 设计教学文档 + "如何新增一个实验"。
- `docs/runs/l3-labs.md`（新增）—— 本报告。

除本文件外，`packages/server/scripts/**` 下的脚本与 `docs/runs/*.md` 均**只读、未编辑**。

## 目录（`GET /api/labs`）

观察到的情况（server 在 `:8797`，`.env` `AGENT_CWD=./data/sandbox`）：

```
enabled=True count=12
id           kind    apiCalls
cache        api            5
forensics    offline
skills       api           12
compaction   api           21
mcp          api           20
subagent     api           10
hooks        offline
scheduler    offline
memory       api           30
orchestrator api           20
tool-search  api           30
approval     api            5
```

三个离线实验（`forensics`、`hooks`、`scheduler`）与脚本自身"零 API / 不调用模型"的头部
声明吻合；另外九个在头部声明了调用预算，以 `apiCalls` 呈现。

## forensics 运行，流式（`POST /api/labs/forensics/run`）

在传输层观察到的帧直方图：

```
frame types {"start":1,"stdout":13,"stderr":2,"exit":1}
exit  data: {"type":"exit","code":0,"durationMs":215}
start data: {"type":"start","id":"forensics","command":"D:\\nodejs\\node.exe D:\\Project\\agent-things\\l3-labs\\node_modules\\.pnpm\\tsx@4.23.15\\node_modules\\tsx\\dist\\cli.mjs D:\\Project\\agent-things\\l3-labs\\packages\\server\\scripts\\forensics-experiment.ts"}
```

流式 `stdout` 包含分类表与汇总：

```
#  case                                    expected    actual  verdict  detail
-  --------------------------------------  --------  --------  -------  -----------------------------------------
1  identical bodies                            none      none     PASS  none · no change anywhere
2  tools reversed                             tools     tools     PASS  tools · reordered: true
3  one tool added (fetch_url)                 tools     tools     PASS  tools · added: ["fetch_url"]
4  system changed 1 byte                     system    system     PASS  system · changedAt set
5  append-only messages                        none      none     PASS  none · messages.appended > 0
6  tools identical, middle message edited  messages  messages     PASS  messages · changedAt > 0, prefix survives

ALL PASS — 6/6 cases
```

以及一个 code 为 `0` 的 `exit` 帧。

## 并发（409）

用一个较长的离线实验（`scheduler`，约 6s）占住槽位时，对 `forensics` 的第二次请求：

```
second status 409 body {"error":"busy","message":"a lab is already running"}
first status 200 has exit true
unknown status 404 {"error":"lab not found"}
```

槽位在 SSE 流打开之前就已预留，所以忙的情况是真正的 `409` JSON 响应，而不是一条空流。

## `LABS_ENABLED=false`（服务器其余不变）

第二个服务器以 `LABS_ENABLED=false` 起在 `:8798`：

```
GET  /api/labs            -> 200 {"enabled":false,"labs":[]}
POST /api/labs/forensics/run -> 403 {"error":"labs are disabled (LABS_ENABLED=false)"}
GET  /api/health          -> 200 {"ok":true,"model":"xiaomi/mimo-v2.6-flash"}
GET  /api/sessions        -> 200
GET  /api/mechanisms      -> 200 keys skills,mcpServers,tools,memory,orchestrator,toolSearch
```

## 浏览器路径（Vite 代理 5173 → 8787）

Labs 标签页实际走的路径：

```
page status 200 content-type text/html
proxied /api/labs status 200 enabled true count 12
proxied run status 200 exit data: {"type":"exit","code":0,"durationMs":334}
proxied run table+pass true
```

## 验证过程中发现并修复的 bug

1. **pnpm 下 `tsx` CLI 的解析。** `require.resolve("tsx/dist/cli.mjs")` 会抛错，因为该包
   的 `exports` map 封死了这个子路径，而朴素的兜底 `node_modules/tsx/...` 在 pnpm 的
   `.pnpm` 布局下并不存在。修法是解析 `tsx/package.json` 并读取其 `bin` 字段。
2. **丢失终止帧。** runner 循环 `while(!closed)` 可能在 `start` 之后、若子进程在 `yield`
   期间跑完时就退出，丢掉已缓冲的 `exit` 帧。改为 `while(!closed || queue.length > 0)`。
3. **cwd 缺失导致的 spawn ENOENT。** 从 `AGENT_CWD`（`./data/sandbox`，当时尚未创建）
   运行子进程会让 `spawn` 以 ENOENT 失败。修法是从仓库根运行实验——它们的相对 import 与
   `.env` 发现都以此为前提。
4. **忙状态报在流上，而不是 `409`。** 起初忙的情况是一条 SSE `error` 帧。把 `LabRunner`
   重构成在 `streamSSE` 之前预留槽位，从而给出真正的 `409`。

## 验收清单

| 检查项 | 结果 |
|---|---|
| `pnpm typecheck`（4 个包） | 全绿 |
| `pnpm --filter @agent/web build` | 全绿 |
| `GET /api/labs` 目录（约 12 个，kind/apiCalls 正确） | 12，3 offline / 9 api |
| `POST /api/labs/forensics/run` 流式输出表 + exit 0 | 是（`ALL PASS — 6/6`） |
| 并发第二次运行 | `409 {"error":"busy"}` |
| 未知 id | `404` |
| `LABS_ENABLED=false` 路由失效、其余不变 | `403` / `{enabled:false}` |
| web Labs 标签页渲染目录 + 实时控制台 | bundle 已核验；代理运行 exit 0 |
| `docs/labs.md` + `docs/runs/l3-labs.md` | 已写 |
| 提交 `L3: labs` | 已完成 |
