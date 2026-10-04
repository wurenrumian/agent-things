import { existsSync } from 'node:fs'
import { dirname, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'

const REPO = 'https://github.com/wurenrumian/agent-things'
const BRANCH = 'master'

// Absolute path to `docs/` (the VitePress srcDir), used to decide whether a
// relative link resolves to a real page in the published site.
const DOCS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Only the teaching material is published as a site. Anything else under
// `docs/` is kept out of the build; links that point at it (or that escape
// `docs/` entirely, e.g. source files) are rewritten to the GitHub repo so the
// reader never lands on a 404 page.
const EXCLUDED = new Set([
  'SPEC.md',
  'ARCHITECTURE.md',
  'ROADMAP.md',
  'CONTRACT.md',
  'STATE.md',
])

const isExcluded = (p: string) => EXCLUDED.has(p) || p.startsWith('briefs/')

function githubUrl(repoPath: string) {
  const isDir = repoPath.endsWith('/')
  const clean = repoPath.replace(/\/+$/, '')
  return `${REPO}/${isDir ? 'tree' : 'blob'}/${BRANCH}/${clean}`
}

export default defineConfig({
  lang: 'zh-CN',
  title: 'agent-things',
  description: '教学型最小 coding agent：边实现、边观测、边讲清每个机制',
  cleanUrls: true,
  ignoreDeadLinks: true,
  lastUpdated: true,

  // Publish only the teaching docs; process/coordination docs stay in the repo.
  srcExclude: [
    'SPEC.md',
    'ARCHITECTURE.md',
    'ROADMAP.md',
    'CONTRACT.md',
    'STATE.md',
    'briefs/**',
  ],

  markdown: {
    config(md) {
      // Wrap VitePress' own `link_open` rule (installed by its linkPlugin) so we
      // can rewrite links before it decides between internal / external.
      const original = md.renderer.rules.link_open
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const token = tokens[idx]
        const hrefIndex = token.attrIndex('href')
        if (hrefIndex >= 0 && token.attrs) {
          const raw = token.attrs[hrefIndex][1]
          // Relative file links only: skip absolute, protocol and anchor links.
          if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(raw)) {
            const pathPart = raw.split(/[?#]/)[0]
            const suffix = raw.slice(pathPart.length)
            const relativePath: string | undefined = env?.relativePath
            const baseDir = relativePath && relativePath.includes('/')
              ? relativePath.slice(0, relativePath.lastIndexOf('/'))
              : ''
            const resolved = posix.normalize(posix.join(baseDir, pathPart))
            const outside = resolved === '..' || resolved.startsWith('../')

            // Decide whether the link survives as an in-site page. Everything
            // that does not is rewritten to the GitHub repo instead of 404ing.
            let repoPath: string | null = null
            if (outside) {
              repoPath = resolved.replace(/^(?:\.\.\/)+/, '')
            } else if (isExcluded(resolved)) {
              repoPath = `docs/${resolved}`
            } else if (resolved.endsWith('/')) {
              // Directory link is only valid in-site if it has an index page.
              if (!existsSync(resolve(DOCS_DIR, resolved, 'index.md'))) {
                repoPath = `docs/${resolved}`
              }
            } else if (resolved.endsWith('.md') && !existsSync(resolve(DOCS_DIR, resolved))) {
              repoPath = `docs/${resolved}`
            }

            if (repoPath) {
              token.attrs[hrefIndex][1] = githubUrl(repoPath) + suffix
            }
          }
        }
        return original
          ? original(tokens, idx, options, env, self)
          : self.renderToken(tokens, idx, options)
      }
    },
  },

  themeConfig: {
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    returnToTopLabel: '回到顶部',
    darkModeSwitchLabel: '主题',
    sidebarMenuLabel: '目录',
    lastUpdatedText: '最后更新',
    search: { provider: 'local' },

    nav: [
      { text: '学习路径', link: '/LEARNING' },
      { text: '常识 vs 实测', link: '/MYTHS' },
      { text: '实验台', link: '/labs' },
      { text: '机制地图', link: '/MECHANISMS' },
      { text: 'GitHub', link: REPO },
    ],

    sidebar: [
      {
        text: '开始',
        items: [
          { text: '首页', link: '/' },
          { text: '三节课学习路径', link: '/LEARNING' },
          { text: '常识 vs 实测', link: '/MYTHS' },
          { text: '实验台（Labs）', link: '/labs' },
          { text: '机制地图', link: '/MECHANISMS' },
        ],
      },
      {
        text: '机制讲解',
        collapsed: false,
        items: [
          { text: 'Skills 渐进披露', link: '/mechanisms/skills' },
          { text: 'MCP 上下文管理', link: '/mechanisms/mcp' },
          { text: '压缩与上下文回收', link: '/mechanisms/compaction' },
          { text: 'Subagent 上下文隔离', link: '/mechanisms/subagent' },
          { text: '权限 / Hooks / Checkpoint', link: '/mechanisms/permissions' },
          { text: 'Scheduler 后台与定时', link: '/mechanisms/scheduler' },
          { text: 'Memory 跨会话记忆', link: '/mechanisms/memory' },
          { text: 'Orchestrator 编排', link: '/mechanisms/orchestrator' },
          { text: '惰性工具暴露', link: '/mechanisms/tool-search' },
          { text: '交互式审批', link: '/mechanisms/approval' },
          { text: '斜杠命令', link: '/mechanisms/commands' },
          { text: '缓存取证', link: '/mechanisms/forensics' },
        ],
      },
      {
        text: '实测证据',
        collapsed: true,
        items: [
          { text: 'M0 验收：read → edit → run', link: '/runs/m0-smoke' },
          { text: 'M1 缓存与 token 经济', link: '/runs/m1-cache' },
          { text: 'M2 Skill 与渐进披露', link: '/runs/m2-skills' },
          { text: 'M3 压缩与上下文回收', link: '/runs/m3-compaction' },
          { text: 'M4 MCP 上下文管理', link: '/runs/m4-mcp' },
          { text: 'M5 子 agent 上下文隔离', link: '/runs/m5-subagent' },
          { text: 'M6 权限 / Hooks / Checkpoint', link: '/runs/m6-permissions' },
          { text: 'M7 后台与定时任务', link: '/runs/m7-scheduler' },
          { text: 'M8 会话 UX 与 CLI', link: '/runs/m8' },
          { text: 'M9 记忆', link: '/runs/m9-memory' },
          { text: 'M10 orchestrator', link: '/runs/m10-orchestrator' },
          { text: 'M11 惰性工具暴露', link: '/runs/m11-tool-search' },
          { text: 'M12 交互式审批 + 斜杠命令', link: '/runs/m12' },
          { text: 'INT-A 接入 skills / MCP / subagent', link: '/runs/int-a' },
          { text: 'INT-B1 接入 hooks + compaction', link: '/runs/int-b1' },
          { text: 'INT-B2 接入 checkpoint + scheduler', link: '/runs/int-b2' },
          { text: 'INT-C 接入 memory / orchestrator / tool-search', link: '/runs/int-c' },
          { text: 'L1 缓存取证', link: '/runs/l1-cache-forensics' },
          { text: 'L3 Labs', link: '/runs/l3-labs' },
        ],
      },
    ],
  },
})
