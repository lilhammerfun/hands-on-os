import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import containerPlugin from 'markdown-it-container'
import mathjax3 from 'markdown-it-mathjax3'

const mathjaxTags = [
  'mjx-container', 'mjx-assistive-mml',
  'math', 'maction', 'maligngroup', 'malignmark', 'menclose', 'merror',
  'mfenced', 'mfrac', 'mi', 'mlongdiv', 'mmultiscripts', 'mn', 'mo',
  'mover', 'mpadded', 'mphantom', 'mroot', 'mrow', 'ms', 'mscarries',
  'mscarry', 'msgroup', 'mstack', 'msline', 'mspace', 'msqrt', 'msrow',
  'mstyle', 'msub', 'msup', 'msubsup', 'mtable', 'mtd', 'mtext', 'mtr',
  'munder', 'munderover', 'semantics', 'annotation', 'annotation-xml',
]

export default withMermaid(
  defineConfig({
    title: '动手学操作系统',
    description: '对照 Linux 内核源码学原理，用 Zig 写 Shell、内存数据库、加密文件系统和操作系统',
    lang: 'zh-CN',
    base: '/hands-on-os/',

    markdown: {
      config: (md) => {
        md.use(mathjax3)

        // Strip <style> tags from mathjax3 SVG output — they cause Vue compiler errors
        const stripStyle = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, '')
        const origInline = md.renderer.rules.math_inline!
        const origBlock = md.renderer.rules.math_block!
        md.renderer.rules.math_inline = (...args) => stripStyle(origInline(...args))
        md.renderer.rules.math_block = (...args) => stripStyle(origBlock(...args))

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
        md.use(containerPlugin, 'practice', {
          render(tokens, idx) {
            const token = tokens[idx]
            if (token.nesting === 1) {
              const title = token.info.trim().slice('practice'.length).trim() || '动手实践'
              return `<div class="practice custom-block"><p class="custom-block-title">${title}</p>\n`
            }
            return '</div>\n'
          }
        })
        md.use(containerPlugin, 'thinking', {
          render(tokens, idx) {
            const token = tokens[idx]
            if (token.nesting === 1) {
              const title = token.info.trim().slice('thinking'.length).trim() || '一起思考 🤔'
              return `<div class="thinking custom-block"><p class="custom-block-title">${title}</p>\n`
            }
            return '</div>\n'
          }
        })
      }
    },

    vue: {
      template: {
        compilerOptions: {
          isCustomElement: (tag) => mathjaxTags.includes(tag),
        },
      },
    },


    themeConfig: {
      nav: [
        { text: '首页', link: '/' },
        { text: '前言', link: '/prologue' },
        { text: '开始学习', link: '/basics/01-os-overview' },
      ],

      sidebar: [
        {
          text: '前言',
          link: '/prologue',
        },
        {
          text: '基础与概览',
          items: [
            { text: '操作系统全景', link: '/basics/01-os-overview' },
            { text: '系统调用与双模式', link: '/basics/02-syscall-dual-mode' },
          ],
        },
        {
          text: '进程管理',
          items: [
            { text: '进程生命周期', link: '/process/01-lifecycle' },
            { text: '信号', link: '/process/02-signal' },
            { text: '进程组与会话', link: '/process/03-process-group' },
            { text: 'CPU 调度', link: '/process/04-scheduling' },
            { text: 'Linux 调度器', link: '/process/05-linux-scheduler' },
            { text: '命名空间', link: '/process/06-namespace' },
            { text: 'Cgroups', link: '/process/07-cgroup' },
          ],
        },
        {
          text: '线程与并发',
          items: [
            { text: '线程', link: '/concurrency/01-thread' },
            { text: '同步原语', link: '/concurrency/02-synchronization' },
            { text: '死锁', link: '/concurrency/03-deadlock' },
            { text: '事件驱动并发', link: '/concurrency/04-event-driven' },
            { text: '内核同步机制', link: '/concurrency/05-kernel-synchronization' },
          ],
        },
        {
          text: '内存管理',
          items: [
            { text: '地址空间与分页', link: '/memory/01-address-space-paging' },
            { text: '虚拟内存', link: '/memory/02-virtual-memory' },
            { text: '内存映射', link: '/memory/03-memory-mapping' },
            { text: '内核内存分配', link: '/memory/04-kernel-memory' },
          ],
        },
        {
          text: '网络与 IPC',
          items: [
            { text: 'Socket 与 TCP', link: '/network/01-socket-tcp' },
            { text: 'IPC 机制', link: '/network/02-ipc' },
            { text: '高性能网络', link: '/network/03-high-performance-network' },
          ],
        },
        {
          text: '存储与 I/O',
          items: [
            { text: 'I/O 系统', link: '/storage/01-io-system' },
            { text: '中断与设备驱动', link: '/storage/02-interrupt-driver' },
            { text: '块层', link: '/storage/03-block-layer' },
          ],
        },
        {
          text: '文件系统',
          items: [
            { text: '文件与目录', link: '/filesystem/01-file-directory' },
            { text: 'VFS 与实现', link: '/filesystem/02-vfs' },
            { text: '日志与一致性', link: '/filesystem/03-journal-consistency' },
            { text: '崩溃一致性实践', link: '/filesystem/04-crash-consistency' },
          ],
        },
        {
          text: '保护与安全',
          items: [
            { text: '保护与安全', link: '/security/01-protection-security' },
          ],
        },
        {
          text: '虚拟化',
          items: [
            { text: '虚拟化', link: '/virtualization/01-virtualization' },
          ],
        },
        {
          text: '可观测性',
          items: [
            { text: '性能分析与内核追踪', link: '/observability/01-perf-tracing' },
          ],
        },
        {
          text: 'zish：Shell',
          items: [
            { text: '基础 REPL', link: '/zish/01-repl' },
            { text: 'Job Control', link: '/zish/02-job-control' },
            { text: '隔离与移植', link: '/zish/03-isolation' },
          ],
        },
        {
          text: 'zedis：内存数据库',
          items: [
            { text: '事件循环与 RESP 协议', link: '/zedis/01-event-loop' },
            { text: 'fork-COW 持久化', link: '/zedis/02-persistence' },
            { text: 'TCP 服务器与 Socket 选项', link: '/zedis/03-networking' },
            { text: '性能分析与优化', link: '/zedis/04-observability' },
          ],
        },
        {
          text: 'zcryptfs：加密文件系统',
          items: [
            { text: 'FUSE 用户态文件系统', link: '/zcryptfs/01-fuse-memfs' },
            { text: '透明加密层', link: '/zcryptfs/02-encryption' },
            { text: '崩溃一致性', link: '/zcryptfs/03-crash-safety' },
          ],
        },
        {
          text: 'zigos：裸机操作系统',
          items: [
            { text: '引导与内存', link: '/zigos/01-boot-memory' },
            { text: '中断与进程', link: '/zigos/02-interrupt-process' },
            { text: '系统调用与文件系统', link: '/zigos/03-syscall-filesystem' },
            { text: '设备与网络', link: '/zigos/04-device-network' },
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
