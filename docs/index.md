---
layout: home

hero:
  name: agent-things
  text: 教学型最小 coding agent
  tagline: 边实现、边观测、边讲清每个机制 —— 对应「本科生的后两节课」
  actions:
    - theme: brand
      text: 三节课学习路径
      link: /LEARNING
    - theme: alt
      text: 常识 vs 实测
      link: /MYTHS
    - theme: alt
      text: 实验台
      link: /labs

features:
  - title: 一切皆上下文
    details: 每个机制都落在「前缀稳定 + 尾部追加」这条不变式上。为什么 skill 不炸缓存、为什么 MCP 是 eager，答案都在注入位置。
  - title: 可测量的机制
    details: 每个里程碑都有一份真实 OpenRouter usage 账本（cached_tokens / cost）。预测一个数字，再对答案。
  - title: 实验即按钮
    details: 12 个实验在观测台里一键运行、实时出账本；多数脚本支持零 API 自检，先省钱再花钱。
  - title: 从读代码开始
    details: 主线只有 5 个文件：loop → content → openrouter → tools/registry → system-prompt。读懂这 5 个，再进 mechanisms。
---

## 怎么用这份站点

1. 先读 [三节课学习路径](/LEARNING)，把「第二课：最小循环」跑通。
2. 对着 [常识 vs 实测](/MYTHS) 逐条**先猜再对**——猜错的地方才是真学到。
3. 卡在某个机制时，进 [机制讲解](/mechanisms/skills)，再对照 [实测证据](/runs/m1-cache)。
4. 想动手，去 [实验台](/labs) 一键跑，或按脚本里的零 API 自检开工。
