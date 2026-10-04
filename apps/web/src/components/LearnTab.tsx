import { useState } from "react";
import learningSrc from "../../../../docs/LEARNING.md?raw";
import mythsSrc from "../../../../docs/MYTHS.md?raw";

/**
 * INT-L — the Learn tab.
 *
 * The learning wave (L1/L2/L3) put the teaching material in `docs/`, but it was
 * only reachable by knowing the path. This tab makes the docs discoverable from
 * inside the observatory. The two markdown docs are pulled in at build time via
 * Vite's `?raw` import — no new dependency and no server route — so they can be
 * read in place. It is read-only: nothing here feeds the model. The Labs tab is
 * one click away, and the Forensics tab is named for when it appears.
 */

interface DocEntry {
  id: string;
  title: string;
  path: string;
  blurb: string;
  body: string;
}

const DOCS: DocEntry[] = [
  {
    id: "learning",
    title: "学习路径 · 三节课",
    path: "docs/LEARNING.md",
    blurb:
      "从最小 coding agent 到逐个机制；每章统一为 心智模型 → 实现文件 → 实验脚本 → 实测数字 → 钩子问题。",
    body: learningSrc,
  },
  {
    id: "myths",
    title: "常识 vs 实测",
    path: "docs/MYTHS.md",
    blurb:
      "用真实 usage 数据推翻或修正“想当然”，每条结论都指向对应的 run 文档。",
    body: mythsSrc,
  },
];

export function LearnTab({ onOpenLabs }: { onOpenLabs: () => void }) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="tab-body learn">
      <p className="learn-intro">
        学习波次的入口都收在这里。文档随仓库走，下面两个标签页是<strong>只读</strong>
        的教学工具——它们只做观测与实验，不会把任何内容喂给模型。
      </p>

      {DOCS.map((doc) => (
        <section className="panel-section learn-card" key={doc.id}>
          <header className="learn-card-head">
            <div className="learn-card-titles">
              <span className="learn-card-title">{doc.title}</span>
              <code className="learn-card-path">{doc.path}</code>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              aria-expanded={open === doc.id}
              onClick={() => setOpen(open === doc.id ? null : doc.id)}
            >
              {open === doc.id ? "收起" : "在应用内阅读"}
            </button>
          </header>
          <p className="learn-card-blurb">{doc.blurb}</p>
          {open === doc.id && <pre className="learn-doc">{doc.body}</pre>}
        </section>
      ))}

      <section className="panel-section learn-card">
        <div className="learn-card-titles">
          <span className="learn-card-title">Labs 实验台</span>
          <code className="learn-card-path">docs/labs.md</code>
        </div>
        <p className="learn-card-blurb">
          12 个实验的一键入口：白名单目录 + 预算确认，运行输出实时流式显示。
        </p>
        <div>
          <button type="button" className="btn btn-primary btn-sm" onClick={onOpenLabs}>
            打开 Labs tab ▶
          </button>
        </div>
      </section>

      <section className="panel-section learn-card">
        <div className="learn-card-titles">
          <span className="learn-card-title">Forensics 缓存取证</span>
        </div>
        <p className="learn-card-blurb">
          谁破坏了缓存：对连续两次请求指出首个分歧块（system / tools / messages）。
          一个会话发过两次请求后，Forensics tab 会自动出现在上方标签栏。
        </p>
      </section>
    </div>
  );
}
