# 机制：Skill 与渐进披露（progressive disclosure）

> 对应 MECHANISMS 的 L4「skill」。实现位于
> `packages/core/src/mechanisms/skills/`，实验数据见
> [`../runs/m2-skills.md`](../runs/m2-skills.md)。

## 1. 一句话

Skill 不是「把一大段提示词塞进 system」，而是**把一段能力拆成三层，按需加载**：
一层永远可见的小元数据，加上按需取用的正文，再加上按需读取的引用文件。
这样模型只有在真正需要时才付出正文的 token 成本，而**已经缓存的前缀不动**。

## 2. 为什么需要它

Agent 的能力本质上就是「在正确时机把正确的字符放进消息数组」。而 provider 的
**前缀缓存**只对稳定前缀命中（M1 已实测：system 改 1 byte 丢 84.6%，append-only 恒命中）。
于是能力注入面临一对矛盾：

- 全量常驻 → 上下文爆炸，且任何改动都可能炸缓存；
- 完全按需 → 模型根本不知道这个能力存在。

渐进披露就是这对矛盾的解：**用一层极小的常驻开销，换取大量内容的惰性加载。**
常驻的元数据必须小且稳定；大块的正文后置到消息数组尾部，不碰缓存前缀。

## 3. 三层

| 层 | 内容 | 何时进上下文 | 体量示意（demo） |
|---|---|---|---|
| **L1 元数据** | `name` + `description` | 永远常驻（system 的 `<available_skills>`） | 256 chars / 2 skills |
| **L2 正文** | `SKILL.md` 的 body | 模型调用 `use_skill` 时，作为 **tool result** | 2625 chars ≈ 657 tok |
| **L3 引用文件** | 正文里指向的相对文件 | 正文命中后进一步按需读取 | `reference/*.md` |

`SKILL.md` 用一层 YAML-ish frontmatter：

```markdown
---
name: code-review
description: Review a diff and report findings by severity.
---
# Code review
...正文...
See `reference/checklist.md` for the full checklist.
```

frontmatter 手写解析（`frontmatter.ts`，无依赖），只支持扁平的 `key: value`。

## 4. 代码 API（`mechanisms/skills/`）

```ts
import { SkillRegistry, createUseSkillTool } from
  "../../core/src/mechanisms/skills/index.js";

// L1：扫描 <root>/*/SKILL.md
const skills = await SkillRegistry.fromFixture();     // 自带 demo fixture
skills.list();            // SkillMetadata[]，按 name 稳定排序
skills.metadataBlock();   // L1 文本，直接放进 system
skills.size();            // 2

// L2：正文
await skills.loadBody("code-review");

// L3：引用文件
await skills.references("code-review");               // 解析并校验存在性
await skills.loadReference("code-review", "reference/checklist.md");

// 工具：execute() 返回 L2 正文（ToolDef 来自 core）
const useSkill = createUseSkillTool(skills);
```

`use_skill` 的 schema：

```jsonc
{
  "name": "use_skill",
  "description": "Load the full instructions of a skill by name. ...",
  "parameters": {
    "type": "object",
    "properties": {
      "name":      { "type": "string" },
      "reference": { "type": "string" }   // 可选 L3
    },
    "required": ["name"]
  }
}
```

`readOnly: true`，`execute()` 只读 registry、返回字符串，不改任何会话状态。

## 5. 接入一个 agent（合并阶段的接线方式）

1. 启动时 `SkillRegistry.scan(skillsDir)`。
2. 把 `registry.metadataBlock()` 作为**稳定 section** 放进 system（或工具描述）。
   这段从不改写。
3. 把 `createUseSkillTool(registry)` 注册进 `ToolRegistry`。注意工具集成员一旦加入
   就固定住（M1：增删工具会炸缓存）。
4. 循环里正常执行工具：`use_skill` 返回的正文作为 `role: "tool"` 消息**追加在尾部**。
5. L3：正文里出现引用文件时，模型再用 `use_skill` 的 `reference` 参数或普通 `read_file` 取。

核心是第 4 步——正文以 **tool result** 进入消息数组尾部，**绝不回头改写 system**。

## 6. 缓存行为（实测，见 runs/m2-skills.md）

同一逻辑前缀（稳定 system 3578 tok），把同一份正文（≈650 tok）用三种方式注入：

| 注入方式 | 注入时 cached | 结论 |
|---|---|---|
| 尾部 user 消息 | 3456（不变） | 前缀保留 |
| tool result | 3456（不变） | 前缀保留；下一轮 99.5% |
| 改写 system（插进前缀内） | **0** | 前缀全失效，成本更高 |

一个关键修正：把正文**追加到 system 末尾**并不会掉缓存（前缀缓存是纯位置的，
只有从“第一个被改动的字节”起才失效）。真正危险的是**在前缀内部做非追加式修改**。
所以纪律是：**只追加，不改写**，无论那条消息是 system 还是 user。

## 7. 设计取舍与边界

- **确定性排序**：`list()` 按 name 排序，保证 L1 文本稳定；否则每次枚举抖动都会全 miss。
- **来源信任**：正文里的引用解析拒绝 `../` 逃逸（`resolveInside`），只读 skill 目录内文件。
- **同步加载 vs 惰性**：`loadBody` / `loadReference` 都是调用时才 `readFile`，
  扫描阶段只读 frontmatter，启动成本低。
- **未做**：skill 的启用/禁用热切换（会改工具集 → 建议用一条尾部消息宣告，而不是改 schema）、
  体积上限与截断、多目录发现的父子合并。这些留待接线阶段。
