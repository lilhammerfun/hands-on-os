import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import containerPlugin from 'markdown-it-container'

export default withMermaid(
  defineConfig({
    title: '从系统工具到操作系统',
    description: '用 Zig 写真实项目，在做的过程中学操作系统',
    lang: 'zh-CN',
    base: '/linux-tutorials/',

    markdown: {
      config: (md) => {
        md.use(containerPlugin, 'expand', {
          render(tokens, idx) {
            const token = tokens[idx]
            if (token.nesting === 1) {
              const title = token.info.trim().slice('expand'.length).trim() || '拓展'
              return `<div class="expand custom-block"><p class="custom-block-title">${title}</p>\n`
            }
            return '</div>\n'
          }
        })
        md.use(containerPlugin, 'insight', {
          render(tokens, idx) {
            const token = tokens[idx]
            if (token.nesting === 1) {
              const title = token.info.trim().slice('insight'.length).trim() || '一起思考 🤔'
              return `<div class="insight custom-block"><p class="custom-block-title">${title}</p>\n`
            }
            return '</div>\n'
          }
        })
      }
    },

    themeConfig: {
      nav: [
        { text: '首页', link: '/' },
        { text: '前言', link: '/prologue' },
      ],

      sidebar: [
        {
          text: '前言',
          link: '/prologue',
        },
        {
          text: '进程管理',
          items: [
            { text: '进程生命周期', link: '/process/01-lifecycle' },
            { text: '信号', link: '/process/02-signal' },
            { text: '进程组与会话', link: '/process/03-process-group' },
            { text: '命名空间', link: '/process/04-namespace' },
          ],
        },
      ],

      search: {
        provider: 'local',
      },

      outline: {
        level: [2, 3],
        label: '目录',
      },

      docFooter: {
        prev: '上一篇',
        next: '下一篇',
      },
    },
  })
)
