# 实验记录 — M2 Skill 与渐进披露

**日期**：2026-10-03
**模型**：`xiaomi/mimo-v2.6-flash`（OpenRouter，自动前缀缓存）
**命令**：

```bash
pnpm --filter @agent/server exec tsx scripts/skills-experiment.ts --salt=mimo-m2-001
# 只跑某一组：
pnpm --filter @agent/server exec tsx scripts/skills-experiment.ts system-rewrite --salt=mimo-m2-001
```

> 复现方式：worktree `m2-skills` 里从主 worktree 复制 `.env`（gitignored，未提交），
> `pnpm install` 后执行上面的命令。`--salt` 会写进每个 system prompt，保证一次运行
> 用的是从未缓存过的新前缀。样本来自 `--salt=mimo-m2-001`。

**环境**：温度 0，`max_tokens=24`，相邻调用间隔 500ms，`session_id` 按场景固定以启用
OpenRouter sticky routing（前缀缓存要求同 provider 实例命中）。
**工具集**（6，`ToolRegistry` 按名稳定排序）：`edit_file, list_dir, read_file,
run_shell, use_skill, write_file`。

## 0. 方法

`packages/server/scripts/skills-experiment.ts` 直接用 `@agent/core` 的
`OpenRouterClient` 发流式请求，绕开 HTTP server，所以**唯一变化的只有 request body**。
每次调用读取真实的 `usage.prompt_tokens_details.cached_tokens`。

被测对象是模块自带的 demo fixture（`packages/core/src/mechanisms/skills/fixtures/`）：

| 级别 | 内容 | 体量 |
|---|---|---|
| L1 metadata | 2 个 skill 的 name+description（`<available_skills>` 常驻） | 256 chars |
| L2 body | `code-review/SKILL.md` 正文 | 2625 chars ≈ 657 tokens |
| L3 refs | `reference/checklist.md`、`reference/report-format.md` | 按需读取 |

三种注入方式，每种跑同一逻辑前缀上的 4 次调用：
`warm#1 / warm#2`（预热并确认稳定前缀命中）→ `inject`（把正文加进去）→ `follow`（再追加一个 turn）。
正文一律由**真实的 `use_skill` ToolDef 的 `execute()` 返回**，保证测的是生产会用到的那个字符串。

关键对照：三种方式给请求体加的**字节完全相同**（同一份 `body`），区别只在**放在消息数组的哪个位置**：

- (a) 作为尾部 `user` 消息追加；
- (b) 作为 `tool` 消息（前面配一条合成 assistant tool_call）；
- (c) 塞进 **system prompt 内部**（真实“改写 system”——正文插在 system 靠前的位置，
  后续所有字节前移）。

## 1. 实测数据

### (a) 尾部 user 消息

| call | label | prompt | **cached** | hit% | cache_write | cost($) |
|---|---|---|---|---|---|---|
| 1 | warm#1 | 3578 | **0** | 0.0 | 0 | 0.000399 |
| 2 | warm#2 | 3578 | **3456** | 96.6 | 0 | 0.000329 |
| 3 | inject-user | 4200 | **3456** | 82.3 | 0 | 0.000400 |
| 4 | follow-user | 4221 | **4096** | 97.0 | 0 | 0.000389 |

### (b) tool result（`use_skill`）

| call | label | prompt | **cached** | hit% | cache_write | cost($) |
|---|---|---|---|---|---|---|
| 1 | warm#1 | 3578 | **3456** | 96.6 | 0 | 0.000329 |
| 2 | warm#2 | 3578 | **3456** | 96.6 | 0 | 0.000329 |
| 3 | inject-tool | 4224 | **3456** | 81.8 | 0 | 0.000402 |
| 4 | follow-tool | 4245 | **4224** | 99.5 | 0 | 0.000388 |

### (c) 改写 system prompt（正文插进前缀）

| call | label | prompt | **cached** | hit% | cache_write | cost($) |
|---|---|---|---|---|---|---|
| 1 | warm#1 | 3578 | **0** | 0.0 | 0 | 0.000399 |
| 2 | warm#2 | 3578 | **3456** | 96.6 | 0 | 0.000331 |
| 3 | inject-system | 4204 | **0** | 0.0 | 0 | 0.000469 |
| 4 | follow-system | 4226 | **640** | 15.1 | 0 | 0.000459 |

### (c′) 对照：把正文**追加到 system 末尾**（不是真正改写）

第一次运行时 (c) 的实现是把正文接在 system 最尾部，结果**没有掉缓存**：

| call | label | prompt | **cached** | hit% | cost($) |
|---|---|---|---|---|---|
| 1 | warm#1 | 3578 | 3456 | 96.6 | 0.000329 |
| 2 | warm#2 | 3578 | 3456 | 96.6 | 0.000329 |
| 3 | inject-system | 4204 | **3456** | 82.2 | 0.000400 |
| 4 | follow-system | 4226 | 4096 | 96.9 | 0.000390 |

## 2. 结论

### 逐条对照 MECHANISMS §6

**Q1 — skill 正文的三种注入方式，各自的 `cached_tokens` 曲线 —— confirmed。**

| 方式 | 预热命中 | 注入时 cached | 注入相对预热 | 判定 |
|---|---|---|---|---|
| (a) 尾部 user 消息 | 3456 | **3456**（prompt 3578→4200） | **不变** | 前缀保留 |
| (b) tool result | 3456 | **3456**（prompt 3578→4224） | **不变** | 前缀保留 |
| (c) 改写 system（插前缀内） | 3456 | **0**（prompt 4204） | **全掉** | 前缀失效 |

(a)/(b) 给请求加了 622–646 token，`cached` 绝对值**纹丝不动**（3456），即只有新追加的
尾部 token 未命中——曲线是健康的 append-only。而 (c) 因为正文**改变了已缓存前缀里的字节**，
`cached` 从 3456 直接掉到 **0**；`follow-system` 才回到 640，即需要**再预热一次**才能重建。
成本上，(c) 注入那一次 `$0.000469`，比 (a)/(b) 的 `$0.000400` 更贵，`follow` 仍偏贵。

### §2 主张：*元数据常驻 + 正文尾部注入保住缓存；改写 system 破坏缓存* —— **confirmed**

- 元数据常驻：`<available_skills>`（256 chars）在所有场景都在稳定前缀里，warm#2 稳定
  命中 3456/3578 = 96.6%。
- 尾部注入：(a) 和 (b) 注入时 `cached` 保持 3456，完全不碰已缓存前缀。
  (b) 的 `follow` 更是 4224/4245 = **99.5%**——正文作为 tool result 落在 tool_call 之后，
  下一轮整段都成了可命中前缀。
- 改写 system：(c) 插入即全 miss（3456→0）。

### 一个重要修正：不是“system 里出现正文”就掉缓存，而是“改到已缓存前缀内的字节”才掉

(c′) 显示：如果只是把正文**追加到 system 的最末尾**，`cached` 仍保持 3456。
原因是前缀缓存是**纯位置**的：从“第一个被改动的字节”之后才失效。把新内容接到 system 尾部，
等价于尾部追加，反而“安全”。只有像真实改写那样把正文**插进前缀内部**（后续字节整体前移），
才会触发全前缀重建。

所以 §2 的准确表述应升级为：**破坏缓存的不是“改 system”这个动作本身，而是“在前缀内部做
非追加式修改”。** 这与 M1 §1.4（system 改 1 byte 掉 86%）和 §1.5（append-only 恒命中）完全一致，
只是把结论精确到了“位置”而非“消息角色”。

## 3. 政策含义（可回填进 `docs/mechanisms/skills.md`）

1. L1 元数据放稳定前缀（system 里的 `<available_skills>` 或工具列表），**极小且永不改写**。
2. L2 正文一律走 `use_skill` 返回的 **tool result**（或尾部 user），**绝不重写 system**。
3. L3 引用文件同样按需追加在尾部，永远不回头改已发送的消息。
4. 如果确实需要在 system 里放正文（例如系统级强制），**只允许追加到末尾**，
   也不能插到既有内容中间。

## 4. 约束遵守

- 只新增文件；未改 `packages/core/src/**`、`packages/server/src/**`、`apps/web/**`、
  任何 `package.json`/lockfile；未改 `docs/CONTRACT.md`/`MECHANISMS.md`/`ROADMAP.md`。
- 未新增依赖（frontmatter 手解析）。
- `.env` 仅工作区本地复制，gitignored，未提交。
- 本里程碑共 **16 次 API 调用**（≤20）。
- `pnpm typecheck` 全包 green。

## 复现

```bash
cp D:/Project/agent-things/.env ./.env      # gitignored
pnpm install
pnpm --filter @agent/server exec tsx scripts/skills-experiment.ts --salt=mimo-m2-001
pnpm typecheck
```
